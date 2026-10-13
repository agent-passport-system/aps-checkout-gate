// The checkout gate core. No HTTP here: server.ts is a thin wrapper.
//
// decide() verifies the grant and the intent with the SDK, then, in one
// IMMEDIATE sqlite transaction, applies idempotency, checks the budget and
// inserts the reservation, signs the decision as an aps:policy-decision:v1
// receipt and stores it. Refusals are signed and stored too.
//
// Only a permit becomes the idempotency answer for its request_id. A refusal
// is logged, and the same request_id with the same content is evaluated again
// later, so a budget_exceeded refusal can become a permit once budget is
// released. Different content under a request_id that holds a permit is
// refused as request_id_conflict.
//
// reportOutcome() and reconcile() move a reservation through its states:
//   reserved   --placed-->               committed
//   reserved   --failed + confirmation--> released
//   reserved   --unknown | timeout-->    unresolved   (budget stays held)
//   reserved   --failed, no confirmation--> unresolved
//   unresolved --reconcile placed-->     committed
//   unresolved --reconcile failed-->     released
// Nothing else moves a reservation, and nothing releases one on a timeout.
//
// On open, recovery moves 'reserved' rows older than the recovery window to
// 'unresolved', never to 'released'.
//
// Durability and atomicity boundary: one sqlite file on one host, WAL journal,
// synchronous FULL, IMMEDIATE transactions. More than one host is not
// established by anything here.

import { randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import { canonicalizeJCS, scopeGrantCovers, verifyAuthorityDelegationChain, verifyReceiptV1 } from 'agent-passport-system'
import type { AuthorityDelegationV1, AuthorityValidationResult, ReceiptV1, RevocationResolution } from 'agent-passport-system'
import { CONTEXT_PROFILE, UNCANONICAL_REQUEST_REF, UNVERIFIED_INTENT, UNVERIFIED_INTENT_REF, issueDecision, reasonOf, reservationOf, verdictOf } from './decision.ts'
import type { DecisionEvidence, DecisionRecord, Verdict } from './decision.ts'
import { purchaseGrant, spendUnit } from './delegation.ts'
import { keyId, keyOf } from './parties.ts'
import type { Party, TrustedKeys } from './parties.ts'
import { isRecord, itemsAmountCheck, requestDigest, requestShapeProblems, sha256Hex } from './request.ts'
import type { PurchaseRequest } from './request.ts'
import { runCheck, validateChecks } from './evidence.ts'
import type { CheckedEvidence, EvidenceCheck } from './evidence.ts'

export interface DecideInput {
  request: PurchaseRequest
  delegation: AuthorityDelegationV1
  intent: ReceiptV1
  /** Evidence for the gate's configured checks, keyed by check name (src/evidence.ts). A key no configured check uses is never read. */
  evidence?: Record<string, unknown>
}

export interface DecideResult {
  record: DecisionRecord
  verdict: Verdict
  reason: string
  reservation_id: string | null
  /** True when this is the stored permit for an earlier identical request. */
  replay: boolean
}

export const DEFAULT_INTENT_MAX_AGE_MS = 5 * 60_000
export const DEFAULT_INTENT_MAX_SKEW_MS = 30_000

export type Outcome = 'placed' | 'failed' | 'unknown' | 'timeout'
export type ReservationState = 'reserved' | 'committed' | 'released' | 'unresolved'
/** Platform evidence for an outcome. This sandbox records it but cannot check it. */
export interface Confirmation { platform_ref: string }
export interface OutcomeResult { ok: boolean; code: string; state?: ReservationState }

export interface Reservation {
  reservation_id: string
  grant_id: string
  request_id: string
  amount_minor: number
  unit: string
  state: ReservationState
  created_at: string
  updated_at: string
}

export interface GateConfig {
  dbPath: string
  gate: Party
  directory: TrustedKeys
  /** 'reserved' rows older than this move to 'unresolved' when the gate opens. */
  recoveryWindowMs?: number
  /** Clock. Tests pass a fixed or advanced clock. */
  now?: () => Date
  /** Test seam only. Busy-waits this long inside the budget transaction,
   *  between reading the held sum and inserting the reservation, so a missing
   *  lock shows up as an overspend instead of depending on scheduler luck.
   *  Zero in normal use. */
  raceWindowMs?: number
  /** An intent issued longer ago than this is refused as intent_stale. Default 5 minutes. */
  intentMaxAgeMs?: number
  /** An intent issued further ahead of the gate clock than this is refused as intent_from_future. Default 30 seconds. */
  intentMaxSkewMs?: number
  /** Optional required evidence: a permit also needs every one of these checks to pass (src/evidence.ts). Off by default.
   *  The first adapter is verdictCheck in src/verdict.ts, an independent signed verdict on the exact request. */
  evidenceChecks?: EvidenceCheck[]
}

export const DEFAULT_RECOVERY_WINDOW_MS = 15 * 60_000

interface Problem { code: string; message: string }

/** The decision evidence while it is being built, plus what the receipt cites. */
type Facts = DecisionEvidence & {
  _cite: { action_ref: string; prev: string; subject_agent: string; delegation_ref: string }
}

const SCHEMA = `
-- One row per request_id that holds a permit. Refusals are not idempotency answers.
CREATE TABLE IF NOT EXISTS requests (
  request_id TEXT PRIMARY KEY,
  request_digest TEXT NOT NULL,
  decision_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  reservation_id TEXT PRIMARY KEY,
  grant_id TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  amount_minor INTEGER NOT NULL CHECK (typeof(amount_minor) = 'integer' AND amount_minor > 0),
  unit TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'released', 'unresolved')),
  created_ms INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reservations_grant_state ON reservations (grant_id, state);
CREATE INDEX IF NOT EXISTS reservations_state_created ON reservations (state, created_ms);
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  request_id TEXT,
  verdict TEXT NOT NULL,
  reason TEXT NOT NULL,
  record TEXT NOT NULL,
  decided_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS revocations (
  delegation_id TEXT PRIMARY KEY,
  revoked_at TEXT NOT NULL,
  reason TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservation_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  cause TEXT NOT NULL,
  evidence TEXT,
  at TEXT NOT NULL
);
`

/** SDK chain failure codes that get their own refusal code. */
const CHAIN_CODES: Record<string, string> = {
  EXPIRED: 'grant_expired',
  NOT_YET_VALID: 'grant_not_yet_valid',
  REVOKED: 'grant_revoked',
  REVOCATION_UNKNOWN: 'revocation_unknown',
}

const isConfirmation = (c: unknown): c is Confirmation =>
  isRecord(c) && Object.keys(c).length === 1 && typeof c.platform_ref === 'string' && c.platform_ref.length > 0

export class Gate {
  readonly db: DatabaseSync
  readonly gate: Party
  readonly directory: TrustedKeys
  readonly recoveryWindowMs: number
  readonly raceWindowMs: number
  readonly intentMaxAgeMs: number
  readonly intentMaxSkewMs: number
  readonly evidenceChecks: readonly EvidenceCheck[]
  /** Reservation ids that startup recovery moved to 'unresolved'. */
  recovered: string[] = []
  private readonly now: () => Date
  private readonly q: Record<string, StatementSync>

  private constructor(c: GateConfig) {
    this.gate = c.gate
    this.directory = c.directory
    this.recoveryWindowMs = c.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS
    this.raceWindowMs = c.raceWindowMs ?? 0
    this.intentMaxAgeMs = c.intentMaxAgeMs ?? DEFAULT_INTENT_MAX_AGE_MS
    validateChecks(c.evidenceChecks ?? [])
    this.evidenceChecks = [...(c.evidenceChecks ?? [])]
    this.intentMaxSkewMs = c.intentMaxSkewMs ?? DEFAULT_INTENT_MAX_SKEW_MS
    this.now = c.now ?? (() => new Date())
    this.db = new DatabaseSync(c.dbPath)
    this.db.exec('PRAGMA busy_timeout = 20000')
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec(SCHEMA)
    const p = (sql: string) => this.db.prepare(sql)
    this.q = {
      getRequest: p('SELECT request_digest, decision_id FROM requests WHERE request_id = ?'),
      putRequest: p('INSERT INTO requests (request_id, request_digest, decision_id) VALUES (?, ?, ?)'),
      getDecision: p('SELECT record FROM decisions WHERE decision_id = ?'),
      // Receipts are deterministic: the same inputs at the same millisecond give
      // the same receipt_id and the same bytes, so a repeat is stored once.
      putDecision: p('INSERT OR IGNORE INTO decisions (decision_id, request_id, verdict, reason, record, decided_at) VALUES (?, ?, ?, ?, ?, ?)'),
      decisionsFor: p('SELECT record FROM decisions WHERE request_id = ? ORDER BY rowid'),
      held: p(`SELECT COALESCE(SUM(amount_minor), 0) AS s FROM reservations
               WHERE grant_id = ? AND state IN ('reserved', 'committed', 'unresolved')`),
      byState: p('SELECT state, COALESCE(SUM(amount_minor), 0) AS s FROM reservations WHERE grant_id = ? GROUP BY state'),
      putReservation: p(`INSERT INTO reservations
        (reservation_id, grant_id, request_id, amount_minor, unit, state, created_ms, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?, ?)`),
      getReservation: p(`SELECT reservation_id, grant_id, request_id, amount_minor, unit, state, created_at, updated_at
        FROM reservations WHERE reservation_id = ?`),
      reservationFor: p('SELECT reservation_id FROM reservations WHERE request_id = ?'),
      setState: p('UPDATE reservations SET state = ?, updated_at = ? WHERE reservation_id = ? AND state = ?'),
      putEvent: p(`INSERT INTO reservation_events (reservation_id, from_state, to_state, cause, evidence, at)
        VALUES (?, ?, ?, ?, ?, ?)`),
      stale: p("SELECT reservation_id FROM reservations WHERE state = 'reserved' AND created_ms <= ? ORDER BY created_ms"),
      revoked: p('SELECT revoked_at FROM revocations WHERE delegation_id = ?'),
      revoke: p('INSERT OR IGNORE INTO revocations (delegation_id, revoked_at, reason) VALUES (?, ?, ?)'),
    }
    this.q.held.setReadBigInts(true)
    this.q.byState.setReadBigInts(true)
  }

  /** Opens the gate on its sqlite file and runs startup recovery. */
  static open(c: GateConfig): Gate {
    const g = new Gate(c)
    g.recovered = g.recover()
    return g
  }

  close(): void {
    this.db.close()
  }

  get keyId(): string {
    return keyId(this.gate.id)
  }

  /** Every write runs here: one IMMEDIATE transaction, so the write lock is
   *  taken before the first read and no other connection can interleave. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      try { this.db.exec('ROLLBACK') } catch { /* already rolled back */ }
      throw e
    }
  }

  private raceWindow(): void {
    if (this.raceWindowMs > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, this.raceWindowMs)
  }

  // ── decide ───────────────────────────────────────────────────────────────

  decide(input: DecideInput): DecideResult {
    const now = this.now()
    const at = now.toISOString()
    // One copy of the input, taken before anything reads it, so a getter or a
    // Proxy cannot answer one check differently from another.
    // Only evidence a configured check uses is read, so unused evidence cannot change the decision.
    let snap: { request: unknown; delegation: unknown; intent: unknown; evidence: Record<string, unknown> }
    try {
      const evidence: Record<string, unknown> = {}
      if (this.evidenceChecks.length > 0) {
        const supplied: unknown = input?.evidence
        for (const c of this.evidenceChecks) evidence[c.name] = isRecord(supplied) && Object.hasOwn(supplied, c.name) ? supplied[c.name] : undefined
      }
      snap = structuredClone({ request: input?.request, delegation: input?.delegation, intent: input?.intent, evidence })
    } catch (e) {
      const msg = `input could not be copied for checking: ${e instanceof Error ? e.message : String(e)}`
      const facts = this.facts(UNCANONICAL_REQUEST_REF, null, null, null, null)
      return this.tx(() => this.result(this.store(this.deny(facts, [{ code: 'malformed_request', message: msg }], at)), false))
    }
    const grantId = isRecord(snap.delegation) && typeof snap.delegation.delegation_id === 'string' ? snap.delegation.delegation_id : null
    const iv = this.verifyIntent(snap.intent)

    const shape = requestShapeProblems(snap.request)
    if (shape.length > 0) {
      const rid = isRecord(snap.request) && typeof snap.request.request_id === 'string' ? snap.request.request_id : null
      let digest: string | null = null
      try { digest = sha256Hex(canonicalizeJCS(snap.request)) } catch { digest = null }
      const facts = this.facts(digest ?? UNCANONICAL_REQUEST_REF, rid, digest, grantId, iv.valid ? snap.intent as ReceiptV1 : null)
      const problems = shape.map(message => ({ code: 'malformed_request', message }))
      return this.tx(() => this.result(this.store(this.deny(facts, problems, at)), false))
    }
    const request = snap.request as PurchaseRequest
    const digest = requestDigest(request)
    const facts = this.facts(digest, request.request_id, digest, grantId, iv.valid ? snap.intent as ReceiptV1 : null)

    return this.tx(() => {
      // Idempotency. Only permits are stored as answers. Identical content gets
      // the stored permit back. Different content under that id is refused.
      const prior = this.q.getRequest.get(request.request_id) as { request_digest: string; decision_id: string } | undefined
      if (prior !== undefined) {
        if (prior.request_digest === digest) return this.result(this.loadDecision(prior.decision_id), true)
        const conflict = [{ code: 'request_id_conflict', message: 'request_id already holds a permit for different request content' }]
        return this.result(this.store(this.deny(facts, conflict, at)), false)
      }

      const problems = this.authorize(request, digest, snap.delegation, snap.intent, iv, now, facts)
      if (this.evidenceChecks.length > 0) {
        // Required evidence, checked offline and before any budget is reserved. Each check gets its own copy of the
        // request. Recorded only when configured, so records from a gate without checks are unchanged.
        const checked: CheckedEvidence[] = []
        for (const c of this.evidenceChecks) {
          const r = runCheck(c, { request: structuredClone(request), action_ref: digest, agent_id: request.agent_id, now: new Date(now) }, snap.evidence[c.name])
          checked.push(r.checked)
          problems.push(...r.problems)
        }
        facts.policy_input.required_evidence = checked
      }
      let reservationId: string | null = null
      if (problems.length === 0) {
        const d = snap.delegation as AuthorityDelegationV1
        const spend = d.authority.spend as { mode: 'bounded'; unit: string; cumulative: string }
        const limit = BigInt(spend.cumulative)
        const held = (this.q.held.get(d.delegation_id) as { s: bigint }).s
        facts.authority_state.held_minor_before = held.toString()
        this.raceWindow()
        const amount = BigInt(request.amount_minor)
        if (held + amount > limit) {
          problems.push({ code: 'budget_exceeded', message: `held ${held} + requested ${amount} exceeds the grant limit ${limit} ${spend.unit}` })
        } else {
          reservationId = `res_${randomBytes(16).toString('hex')}`
          this.q.putReservation.run(reservationId, d.delegation_id, request.request_id, request.amount_minor, spend.unit, now.getTime(), at, at)
        }
      }
      const record = reservationId !== null
        ? this.permit(facts, reservationId, snap.delegation as AuthorityDelegationV1, now)
        : this.deny(facts, problems, at)
      // A permit becomes the request_id's answer. A refusal is only logged.
      this.store(record, reservationId !== null ? digest : undefined)
      return this.result(record, false)
    })
  }

  private verifyIntent(intent: unknown): { valid: boolean; status: string; errors: string[] } {
    if (!isRecord(intent)) return { valid: false, status: 'invalid', errors: ['intent is not an object'] }
    try {
      const r = verifyReceiptV1(intent as unknown as ReceiptV1, signer => keyOf(this.directory, signer, 'agent'), { expectedReceiptType: 'aps:action-intent:v1' })
      return { valid: r.valid, status: r.status, errors: r.errors }
    } catch (e) {
      return { valid: false, status: 'invalid', errors: [e instanceof Error ? e.message : String(e)] }
    }
  }

  /** Grant, items and intent checks. Returns every problem found, in check
   *  order. Fills the grant's spend facts into the evidence. */
  private authorize(
    request: PurchaseRequest, digest: string, delegation: unknown, intent: unknown,
    iv: { valid: boolean; status: string; errors: string[] }, now: Date, facts: DecisionEvidence,
  ): Problem[] {
    const problems: Problem[] = []

    // 1. The grant: signature, chain, trust root, validity time and revocation,
    // all through the SDK. Revocation is answered from the local sqlite list,
    // read inside this transaction.
    let chain: AuthorityValidationResult
    try {
      chain = verifyAuthorityDelegationChain([delegation as AuthorityDelegationV1], {
        now: now.toISOString(),
        resolveVerificationKey: issuer => keyOf(this.directory, issuer, 'principal') ?? null,
        trustRoot: root => keyOf(this.directory, root.issuer, 'principal') !== undefined,
        resolveRevocation: d => this.revocationStatus(d.delegation_id),
      })
    } catch (e) {
      chain = { state: 'invalid', valid: false, failures: [{ code: 'SCHEMA_INVALID', message: e instanceof Error ? e.message : String(e) }] }
    }
    if (!chain.valid) {
      for (const f of chain.failures) problems.push({ code: CHAIN_CODES[f.code] ?? 'delegation_invalid', message: `delegation ${f.code}: ${f.message}` })
      if (chain.failures.length === 0) problems.push({ code: 'delegation_invalid', message: `delegation ${chain.state}` })
    } else {
      const d = delegation as AuthorityDelegationV1
      if (d.subject !== request.agent_id) {
        problems.push({ code: 'agent_not_delegated', message: 'the grant subject is not the requesting agent' })
      }
      // 2. Scope: the merchant and the action.
      const needed = purchaseGrant(request.merchant_id)
      if (!d.authority.scope.grants.some(g => scopeGrantCovers(g, needed))) {
        problems.push({ code: 'out_of_scope', message: `no grant covers ${needed}` })
      }
      // 3. Spend facet: bounded, same unit, per-request limit.
      const spend = d.authority.spend
      if (spend.mode !== 'bounded') {
        problems.push({ code: 'no_spend_limit', message: 'the grant has an unbounded spend facet, and this gate requires a limit' })
      } else {
        facts.authority_state.spend_unit = spend.unit
        facts.authority_state.cumulative_minor = spend.cumulative
        if (spend.unit !== spendUnit(request.currency)) {
          problems.push({ code: 'currency_mismatch', message: `the grant is in ${spend.unit}, the request in ${spendUnit(request.currency)}` })
        } else if (BigInt(request.amount_minor) > BigInt(spend.per_action)) {
          problems.push({ code: 'per_request_limit_exceeded', message: `amount ${request.amount_minor} exceeds the per-request limit ${spend.per_action} ${spend.unit}` })
        }
      }
    }

    // 4. Line items. Priced items must sum to the amount. Unpriced items leave
    // the amount unchecked, and the evidence says so.
    const items = itemsAmountCheck(request)
    facts.policy_input.items_priced = items.priced
    if (items.problem !== undefined) problems.push({ code: 'items_amount_mismatch', message: items.problem })

    // 5. The intent: signed by the delegated agent, fresh, over exactly this
    // request, naming this grant.
    if (!isRecord(intent)) {
      problems.push({ code: 'intent_invalid', message: 'intent is not an object' })
      return problems
    }
    if (!iv.valid) problems.push({ code: 'intent_invalid', message: `intent receipt ${iv.status}: ${iv.errors.join(' | ')}` })
    const signers = Array.isArray(intent.signatures) ? intent.signatures.map(s => (isRecord(s) ? s.signer : undefined)) : []
    if (intent.issuer !== request.agent_id || intent.subject_agent !== request.agent_id ||
      signers.length === 0 || !signers.every(s => s === request.agent_id)) {
      problems.push({ code: 'intent_signer_mismatch', message: 'the intent is not issued and signed by the requesting agent alone' })
    }
    if (iv.valid) {
      // issued_at is signed and, once the receipt verifies, exact UTC milliseconds.
      const issued = Date.parse(intent.issued_at as string)
      if (now.getTime() - issued > this.intentMaxAgeMs) {
        problems.push({ code: 'intent_stale', message: `intent issued ${now.getTime() - issued} ms ago, the limit is ${this.intentMaxAgeMs} ms` })
      } else if (issued - now.getTime() > this.intentMaxSkewMs) {
        problems.push({ code: 'intent_from_future', message: `intent issued ${issued - now.getTime()} ms ahead of the gate clock, the limit is ${this.intentMaxSkewMs} ms` })
      }
    }
    if (intent.action_ref !== digest) problems.push({ code: 'intent_request_mismatch', message: 'the intent does not commit to this exact request' })
    if (!isRecord(delegation) || intent.delegation_ref !== delegation.delegation_id) {
      problems.push({ code: 'intent_delegation_mismatch', message: 'the intent names a different grant' })
    }
    return problems
  }

  private revocationStatus(delegationId: string): RevocationResolution {
    return this.q.revoked.get(delegationId) === undefined ? 'active' : 'revoked'
  }

  /** The decision evidence before the verdict is known. The intent is cited
   *  only when its signature verified. Otherwise the receipt names no agent
   *  and no intent, as in noncommercial-access-demo. */
  private facts(actionRef: string, requestId: string | null, digest: string | null, grantId: string | null, verifiedIntent: ReceiptV1 | null): Facts {
    return {
      _cite: {
        action_ref: actionRef,
        prev: verifiedIntent?.receipt_id ?? UNVERIFIED_INTENT_REF,
        subject_agent: verifiedIntent?.subject_agent ?? UNVERIFIED_INTENT,
        delegation_ref: grantId ?? 'no-delegation',
      },
      authority_state: { grant_id: grantId, spend_unit: null, cumulative_minor: null, held_minor_before: null },
      policy_input: { request_id: requestId, request_digest: digest, intent_receipt_id: verifiedIntent?.receipt_id ?? null, items_priced: null },
      decision_context: { profile: CONTEXT_PROFILE, reason: '', reasons: [], reservation_id: null, gate_id: this.gate.id },
      decision_output: { profile: 'aps-core-decision-output-v1', verdict: 'deny', effective_authority_ref: null, constraints: [], valid_until: null },
    }
  }

  private issue(f: Facts, at: string): DecisionRecord {
    const { _cite, ...evidence } = f
    return issueDecision(this.gate, { ..._cite, issued_at: at, evidence })
  }

  private permit(f: Facts, reservationId: string, d: AuthorityDelegationV1, now: Date): DecisionRecord {
    f.decision_context = { ...f.decision_context, reason: 'permitted', reasons: [], reservation_id: reservationId }
    f.decision_output = {
      profile: 'aps-core-decision-output-v1',
      verdict: 'permit',
      // The grant's own digest: delegation_id is "sha256:<hex>".
      effective_authority_ref: d.delegation_id.replace(/^sha256:/, ''),
      constraints: [],
      // After this, startup recovery may move the reservation to unresolved.
      valid_until: new Date(now.getTime() + Math.max(this.recoveryWindowMs, 1)).toISOString(),
    }
    return this.issue(f, now.toISOString())
  }

  private deny(f: Facts, problems: Problem[], at: string): DecisionRecord {
    f.decision_context = {
      ...f.decision_context,
      reason: problems[0]?.code ?? 'refused',
      reasons: problems.map(p => `${p.code}: ${p.message}`),
      reservation_id: null,
    }
    return this.issue(f, at)
  }

  private result(record: DecisionRecord, replay: boolean): DecideResult {
    return { record, verdict: verdictOf(record), reason: reasonOf(record), reservation_id: reservationOf(record), replay }
  }

  /** Stores a decision in the log. With a digest it also becomes the
   *  request_id's idempotency answer, which only a permit does. */
  private store(record: DecisionRecord, digest?: string): DecisionRecord {
    const rid = record.evidence.policy_input.request_id
    this.q.putDecision.run(record.receipt.receipt_id, rid, verdictOf(record), reasonOf(record), JSON.stringify(record), record.receipt.issued_at)
    if (digest !== undefined && rid !== null) this.q.putRequest.run(rid, digest, record.receipt.receipt_id)
    return record
  }

  private loadDecision(decisionId: string): DecisionRecord {
    const row = this.q.getDecision.get(decisionId) as { record: string } | undefined
    if (!row) throw new Error(`stored decision ${decisionId} is missing`)
    return JSON.parse(row.record) as DecisionRecord
  }

  // ── outcomes ─────────────────────────────────────────────────────────────

  /** What the checkout reports after it tried to place the order. */
  reportOutcome(reservationId: string, outcome: Outcome, confirmation?: Confirmation): OutcomeResult {
    const at = this.now().toISOString()
    return this.tx(() => {
      const row = this.q.getReservation.get(reservationId) as Reservation | undefined
      if (!row) return { ok: false, code: 'not_found' }
      if (row.state !== 'reserved') return { ok: false, code: 'invalid_state', state: row.state }
      let next: ReservationState
      if (outcome === 'placed') next = 'committed'
      else if (outcome === 'failed') next = isConfirmation(confirmation) ? 'released' : 'unresolved'
      else if (outcome === 'unknown' || outcome === 'timeout') next = 'unresolved'
      else return { ok: false, code: 'invalid_outcome' }
      this.transition(row, next, `outcome:${outcome}`, confirmation, at)
      return { ok: true, code: 'recorded', state: next }
    })
  }

  /** The only way out of 'unresolved'. Needs platform confirmation. */
  reconcile(reservationId: string, confirmed: { outcome: 'placed' | 'failed'; confirmation: Confirmation }): OutcomeResult {
    if (!isRecord(confirmed) || !isConfirmation(confirmed.confirmation)) return { ok: false, code: 'confirmation_required' }
    const at = this.now().toISOString()
    return this.tx(() => {
      const row = this.q.getReservation.get(reservationId) as Reservation | undefined
      if (!row) return { ok: false, code: 'not_found' }
      if (row.state !== 'unresolved') return { ok: false, code: 'invalid_state', state: row.state }
      let next: ReservationState
      if (confirmed.outcome === 'placed') next = 'committed'
      else if (confirmed.outcome === 'failed') next = 'released'
      else return { ok: false, code: 'invalid_outcome' }
      this.transition(row, next, `reconcile:${confirmed.outcome}`, confirmed.confirmation, at)
      return { ok: true, code: 'reconciled', state: next }
    })
  }

  private transition(row: Reservation, next: ReservationState, cause: string, evidence: unknown, at: string): void {
    const r = this.q.setState.run(next, at, row.reservation_id, row.state)
    if (r.changes !== 1) throw new Error(`reservation ${row.reservation_id} changed under the transaction`)
    this.q.putEvent.run(row.reservation_id, row.state, next, cause, evidence === undefined ? null : JSON.stringify(evidence), at)
  }

  /** Startup recovery. A 'reserved' row older than the window belongs to a
   *  checkout that never reported back, for example after a crash. Its order
   *  may or may not exist, so it becomes 'unresolved' and keeps holding budget. */
  recover(): string[] {
    const now = this.now()
    const cutoff = now.getTime() - this.recoveryWindowMs
    return this.tx(() => {
      const rows = this.q.stale.all(cutoff) as { reservation_id: string }[]
      for (const { reservation_id } of rows) {
        const row = this.q.getReservation.get(reservation_id) as unknown as Reservation
        this.transition(row, 'unresolved', 'startup_recovery', undefined, now.toISOString())
      }
      return rows.map(r => r.reservation_id)
    })
  }

  // ── administration and reads ─────────────────────────────────────────────

  /** Adds a grant to the local revocation list. Later decisions refuse it. */
  revoke(delegationId: string, reason: string): void {
    const at = this.now().toISOString()
    this.tx(() => { this.q.revoke.run(delegationId, at, reason) })
  }

  reservation(reservationId: string): Reservation | undefined {
    return this.q.getReservation.get(reservationId) as Reservation | undefined
  }

  reservationForRequest(requestId: string): string | undefined {
    return (this.q.reservationFor.get(requestId) as { reservation_id: string } | undefined)?.reservation_id
  }

  decisionsForRequest(requestId: string): DecisionRecord[] {
    return (this.q.decisionsFor.all(requestId) as { record: string }[]).map(r => JSON.parse(r.record) as DecisionRecord)
  }

  decision(decisionId: string): DecisionRecord | undefined {
    const row = this.q.getDecision.get(decisionId) as { record: string } | undefined
    return row ? (JSON.parse(row.record) as DecisionRecord) : undefined
  }

  /** Integer minor units per state for one grant, as decimal strings. */
  budget(grantId: string): Record<ReservationState | 'held', string> {
    const out: Record<ReservationState | 'held', bigint> = { reserved: 0n, committed: 0n, released: 0n, unresolved: 0n, held: 0n }
    for (const r of this.q.byState.all(grantId) as { state: ReservationState; s: bigint }[]) out[r.state] = r.s
    out.held = out.reserved + out.committed + out.unresolved
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.toString()])) as Record<ReservationState | 'held', string>
  }
}
