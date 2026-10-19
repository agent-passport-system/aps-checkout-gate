// APS payer adapter for ogasurfproject-jpg/horizon-shield#51 (local, not deployed).
// Order per call: build the occurrence, gate decision, payment statement, every binding check,
// claim the occurrence in a durable ledger, send once, then bind the response to its signed receipt.
// Payment, execution and acceptance are reported separately. Acceptance is not evaluated here.

import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { canonicalizeJCS } from 'agent-passport-system'
import type { AuthorityDelegationV1 } from 'agent-passport-system'
import { verifyDecision } from '../../src/decision.ts'
import type { Gate } from '../../src/gate.ts'
import type { Party } from '../../src/parties.ts'
import { signIntent } from '../../src/request.ts'
import type { PurchaseRequest } from '../../src/request.ts'
// @ts-ignore plain JS module, vendored byte for byte from horizon-shield fe8050a5
import * as hs from './vendor/pilot-fe8050a5.mjs'

export const MERCHANT = 'horizon-shield'
export const SERVICE = 'estimate-audit'
/** Proposed pilot convention, not established: 1 JPY-testnet = 1 iso4217:JPY:minor. */
export const UNIT_MAP: Record<string, string> = { 'JPY-testnet': 'JPY' }

/** Builds the rail receipt reference a payment statement carries, by digest. It must be pure: no funds
 *  move, no network, same inputs give the same output. It is called once per payment statement, before
 *  the binding checks, so an effectful transfer must never be plugged in here.
 *  #51 runs on the fallback, a signed test transfer (horizon-shield#51 comment 6256765798): there is no
 *  x402 rail behind the pilot endpoint, no funds move, and the payment statement is what is signed. The
 *  rail receipt is the JCS stub below, unsigned, carried by digest. Its bytes are kept as a file next to
 *  the payment (see Ctx.keep). A real rail would need its own step after the ledger claim. Not built.
 *  The stub follows stub_rail_receipt in horizon-shield pilot_rehearsal.py at d7e640d1. */
export type RailReceiptBuilder = (requestSha: string, amount: number, unit: string) => Promise<{ kind: string; receipt_sha256: string | null }>
/** The exact rail receipt bytes of the fallback: JCS of the stub object. */
export const testTransferBytes = (request_sha256: string, amount: number, unit: string): string =>
  hs.jcs({ type: 'signed-test-transfer.v0', request_sha256, amount, unit })
export const signedTestTransfer: RailReceiptBuilder = async (request_sha256, amount, unit) =>
  ({ kind: 'signed-test-transfer', receipt_sha256: await hs.sha256hex(testTransferBytes(request_sha256, amount, unit)) })
export const noRail: RailReceiptBuilder = async () => ({ kind: 'rehearsal-no-rail', receipt_sha256: null })

export class AdapterRefusal extends Error {
  code: string
  constructor(code: string) { super(code); this.code = code }
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')
export const lineageOf = (grant: AuthorityDelegationV1) => ['sha256:' + sha(canonicalizeJCS(grant))]
const same = (a: unknown, b: unknown) => hs.jcs(a) === hs.jcs(b)

/** One row per request occurrence digest. A row is claimed once, before sending, and never
 *  reclaimed, so a retry, a concurrent attempt or a restart cannot send the same occurrence twice.
 *  A row left in 'sending' or 'unknown' needs manual reconciliation, nothing resends it. */
export class Ledger {
  db: DatabaseSync
  constructor(path: string) {
    this.db = new DatabaseSync(path)
    this.db.exec(`CREATE TABLE IF NOT EXISTS dispatches (
      request_sha256 TEXT PRIMARY KEY, occurrence_id TEXT NOT NULL, reservation_id TEXT NOT NULL,
      state TEXT NOT NULL, detail TEXT, updated_at TEXT NOT NULL)`)
  }
  get(requestSha: string): { state: string; detail: string | null } | undefined {
    return this.db.prepare('SELECT state, detail FROM dispatches WHERE request_sha256 = ?').get(requestSha) as never
  }
  claim(requestSha: string, occurrenceId: string, reservationId: string): boolean {
    const r = this.db.prepare(`INSERT OR IGNORE INTO dispatches (request_sha256, occurrence_id, reservation_id, state, updated_at)
      VALUES (?, ?, ?, 'sending', ?)`).run(requestSha, occurrenceId, reservationId, new Date().toISOString())
    return Number(r.changes) === 1
  }
  set(requestSha: string, state: string, detail: string | null = null) {
    this.db.prepare('UPDATE dispatches SET state = ?, detail = ?, updated_at = ? WHERE request_sha256 = ?')
      .run(state, detail, new Date().toISOString(), requestSha)
  }
  close() { this.db.close() }
}

export interface Ctx {
  gate: Gate
  gateParty: Party
  grant: AuthorityDelegationV1
  agent: Party            // APS agent: signs the intent, and as the MUSUBI caller signs the payment
  caller: string          // the same key as hex, checked by makeCtx
  responder: string       // responder key advertised by the endpoint
  price: number
  unit: string
  fixture: unknown
  fixtureSha: string      // frozen fixture digest from #51
  ledger: Ledger
  dispatch: (body: any) => Promise<any>
  now: () => Date
  rail?: RailReceiptBuilder   // pure, defaults to noRail
  /** Durable copy of what a payment stands on, keyed by the request occurrence digest: the payment
   *  statement as sent and, for the fallback rail, the rail receipt bytes. Called after every binding
   *  check and before the ledger claim, so nothing is sent unless these files were written. Required
   *  for the signed-test-transfer rail. If it fails, the occurrence is spent: the gate keeps its decision,
   *  a retry returns gate_replay and sends nothing, and recovery needs a new occurrence_id. */
  keep?: (requestSha: string, files: Record<string, string>) => void | Promise<void>
}

/** Checks the key association once: the APS agent key must be the MUSUBI caller key. */
export async function makeCtx(c: Omit<Ctx, 'caller'>): Promise<Ctx> {
  const caller: string = await hs.publicKeyHex(c.agent.privateKey)
  if (caller !== c.agent.publicKey) throw new AdapterRefusal('agent_key_is_not_caller_key')
  if (await hs.sha256hex(hs.jcs(c.fixture)) !== c.fixtureSha) throw new AdapterRefusal('fixture_not_frozen_fixture')
  return { ...c, caller }
}

/** The MUSUBI task and request occurrence, and the gate request that commits to them. */
export async function buildOccurrence(ctx: Ctx, occurrenceId: string, nonce: string, unit = ctx.unit) {
  const task = { type: 'musubi.ca2a.task.v0', service: SERVICE, amount: ctx.price, unit, nonce }
  const taskSha: string = await hs.checkTask(task)
  const request = { type: 'musubi.ca2a.request.v0', caller: ctx.caller, responder: ctx.responder,
    lineage: lineageOf(ctx.grant), capability: SERVICE, occurrence_id: occurrenceId, task_sha256: taskSha }
  // The digest the worker computes: the whole accepted request object, type included.
  const requestSha: string = await hs.checkRequest(request)
  const currency = UNIT_MAP[task.unit]
  if (!currency) throw new AdapterRefusal('unit_not_mapped')
  const gateReq: PurchaseRequest = { request_id: occurrenceId, agent_id: ctx.agent.id, merchant_id: MERCHANT,
    order_ref: requestSha, items: [{ sku: SERVICE, quantity: 1, unit_price_minor: task.amount }],
    amount_minor: task.amount, currency }
  return { task, request, requestSha, gateReq }
}

/** Every binding the adapter owns, checked before a payment leaves or the call is sent.
 *  The gate commits to order_ref and the amount. Everything else in the call is checked here. */
export async function preDispatch(ctx: Ctx, record: any, gateReq: PurchaseRequest, body: any, rail: unknown) {
  const fail = (code: string) => { throw new AdapterRefusal(code) }
  if (!verifyDecision(record, ctx.gateParty.id, ctx.gateParty.publicKey).valid) fail('decision_invalid')
  if (record.receipt.result.verdict !== 'permit') fail('not_permitted')
  if (record.receipt.action_ref !== sha(canonicalizeJCS(gateReq))) fail('decision_for_another_request')
  const { request, task, payment, fixture } = body
  let requestSha: string, taskSha: string
  try { requestSha = await hs.checkRequest(request); taskSha = await hs.checkTask(task) } catch { return fail('call_shape') }
  if (requestSha! !== gateReq.order_ref) fail('occurrence_not_permitted')
  if (request.task_sha256 !== taskSha!) fail('task_not_in_request')
  if (task.service !== SERVICE || request.capability !== SERVICE) fail('not_this_service')
  if (task.amount !== gateReq.amount_minor || UNIT_MAP[task.unit] !== gateReq.currency) fail('task_not_permitted')
  if (request.responder !== ctx.responder) fail('responder_not_advertised')
  if (request.caller !== ctx.caller) fail('caller_mismatch')
  if (!same(request.lineage, lineageOf(ctx.grant))) fail('lineage_not_this_grant')
  if (await hs.sha256hex(hs.jcs(fixture)) !== ctx.fixtureSha) fail('fixture_not_frozen_fixture')
  if (payment.type !== 'musubi.ca2a.payment-receipt.v0') fail('payment_shape')
  if (payment.payer !== ctx.caller || !(await hs.verify(payment, 'payer'))) fail('payment_signature_invalid')
  if (payment.payee !== ctx.responder) fail('payment_not_to_this_responder')
  if (payment.request_sha256 !== gateReq.order_ref) fail('payment_for_another_request')
  if (!same(payment.lineage, request.lineage)) fail('payment_lineage_mismatch')
  if (payment.amount !== task.amount || payment.unit !== task.unit) fail('payment_amount_not_permitted')
  if (!same(payment.rail, rail)) fail('rail_receipt_not_this_payment')
}

/** The response counts as this call's execution only if the signed receipt names this call and the
 *  returned audit is the one whose digest the receipt signs. */
export async function bindResponse(ctx: Ctx, body: any, result: any): Promise<string | null> {
  const rc = result && result.receipt
  if (!rc || !(await hs.verify(rc, 'responder'))) return 'receipt_signature_invalid'
  if (rc.type !== 'musubi.ca2a.execution-receipt.v0') return 'receipt_type'
  if (rc.responder !== ctx.responder || rc.caller !== ctx.caller) return 'receipt_parties'
  if (rc.request_sha256 !== body.payment.request_sha256 || result.request_sha256 !== rc.request_sha256) return 'receipt_for_another_request'
  if (!same(rc.lineage, body.request.lineage) || rc.capability !== body.request.capability) return 'receipt_lineage_or_capability'
  if (!rc.outcome || rc.outcome.kind !== 'result' || rc.outcome.stage !== 'audited') return 'receipt_outcome'
  if (await hs.sha256hex(hs.jcs(result.audit)) !== rc.outcome.response_sha256) return 'audit_not_signed_audit'
  return null
}

export interface Attempt {
  occurrenceId: string; requestSha: string
  verdict: string | null; reason: string | null; receipt_id: string | null
  refused?: string
  payment: 'none' | 'statement_signed'          // no rail yet: a signed statement, no funds moved
  execution: 'not_sent' | 'receipt_verified' | 'unbound' | 'unknown'
  acceptance: 'not_evaluated'
  budget?: string                               // reservation state after the attempt
  result?: any
}

/** One paid call. tamper changes the call after the permit, to show the checks stop it. */
export async function payOnce(ctx: Ctx, occurrenceId: string, nonce: string, seen: { height: number; hash: string },
  tamper?: (body: any) => Promise<any>): Promise<Attempt> {
  const o = await buildOccurrence(ctx, occurrenceId, nonce)
  const a: Attempt = { occurrenceId, requestSha: o.requestSha, verdict: null, reason: null, receipt_id: null,
    payment: 'none', execution: 'not_sent', acceptance: 'not_evaluated' }
  const prior = ctx.ledger.get(o.requestSha)
  if (prior) return { ...a, refused: 'already_attempted:' + prior.state }
  const r = ctx.gate.decide({ request: o.gateReq, delegation: ctx.grant, intent: signIntent(o.gateReq, ctx.agent, ctx.grant, ctx.now()) })
  Object.assign(a, { verdict: r.verdict, reason: r.reason ?? null, receipt_id: r.record.receipt.receipt_id })
  if (r.verdict !== 'permit') return a
  // A stored permit means an earlier identical attempt owns this reservation. Never send on it.
  if (r.replay) return { ...a, refused: 'gate_replay' }
  // Built once for this occurrence, then signed into the statement and checked against it before sending.
  const rail = await (ctx.rail ?? noRail)(o.requestSha, o.task.amount, o.task.unit)
  const expectedRail = structuredClone(rail)
  const payment = await hs.sign({ type: 'musubi.ca2a.payment-receipt.v0', payer: ctx.caller, payee: ctx.responder,
    lineage: o.request.lineage, request_sha256: o.requestSha, amount: o.task.amount, unit: o.task.unit,
    seen_block: seen, rail }, ctx.agent.privateKey)
  let body: any = { request: o.request, task: o.task, fixture: ctx.fixture, payment }
  if (tamper) body = await tamper(body)
  // One private copy is checked, kept and sent, so nothing the caller still holds (seen, fixture) can
  // change the bytes between the checks, the kept files and the dispatch.
  body = structuredClone(body)
  try {
    await preDispatch(ctx, r.record, o.gateReq, body, expectedRail)
    // The fallback rail exists only as kept bytes, so without a keeper the payment is not sent.
    if (expectedRail.kind === 'signed-test-transfer' && !ctx.keep) throw new AdapterRefusal('payment_files_not_kept')
    if (ctx.keep) {
      const files: Record<string, string> = { 'payment.json': hs.jcs(body.payment) }
      if (expectedRail.kind === 'signed-test-transfer') {
        const bytes = testTransferBytes(o.requestSha, o.task.amount, o.task.unit)
        if (await hs.sha256hex(bytes) !== expectedRail.receipt_sha256) throw new AdapterRefusal('rail_bytes_not_this_digest')
        files['rail-receipt.json'] = bytes
      }
      try { await ctx.keep(o.requestSha, files) } catch { throw new AdapterRefusal('payment_files_not_kept') }
    }
  } catch (e) {
    if (!(e instanceof AdapterRefusal)) throw e
    // Nothing left the payer, so the reservation is released with that as its confirmation.
    const rel = ctx.gate.reportOutcome(r.reservation_id!, 'failed', { platform_ref: 'not-dispatched:' + e.code })
    return { ...a, refused: e.code, payment: 'statement_signed', budget: rel.state }
  }
  if (!ctx.ledger.claim(o.requestSha, occurrenceId, r.reservation_id!)) return { ...a, refused: 'already_attempted:claimed' }
  a.payment = 'statement_signed'
  let result: any
  try {
    result = await ctx.dispatch(body)
  } catch (e) {
    // Sent, no usable response. The budget stays held and the ledger row blocks any resend.
    ctx.ledger.set(o.requestSha, 'unknown', String((e as any)?.code ?? e))
    const u = ctx.gate.reportOutcome(r.reservation_id!, 'unknown')
    return { ...a, refused: 'dispatch_failed:' + ((e as any)?.code ?? 'error'), execution: 'unknown', budget: u.state }
  }
  const unbound = await bindResponse(ctx, body, result)
  if (unbound) {
    ctx.ledger.set(o.requestSha, 'unbound', unbound)
    const u = ctx.gate.reportOutcome(r.reservation_id!, 'unknown')
    return { ...a, refused: unbound, execution: 'unbound', budget: u.state, result }
  }
  ctx.ledger.set(o.requestSha, 'executed', result.receipt.outcome.response_sha256)
  const placed = ctx.gate.reportOutcome(r.reservation_id!, 'placed',
    { platform_ref: 'musubi-receipt:sha256:' + (await hs.sha256hex(hs.jcs(result.receipt))) })
  return { ...a, execution: 'receipt_verified', budget: placed.state, result }
}
