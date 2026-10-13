// Optional required evidence: a hook a store can use to make a permit depend on
// evidence beyond the delegation and the intent, without editing gate.ts.
//
// A store configures the gate with a list of checks. Each check has a name; the
// caller supplies its evidence under that name in DecideInput.evidence. Each check
// gets a copy of the request, its own evidence, the request's action_ref (the JCS
// digest the gate already uses), the agent and the gate's clock, and returns its
// refusal reasons plus an id for the evidence it checked. The gate records that id
// in the decision evidence and refuses, before any budget is reserved, when:
//   - the evidence for a configured check is absent       -> evidence_missing
//   - a check throws                                      -> evidence_check_failed
//   - a check returns anything but {problems, evidence_id} -> evidence_check_failed
//   - a check returns problems                            -> those problems
// Evidence under a name no configured check uses is never read or copied, so it
// cannot change the decision. Checks run offline: the gate calls nothing.

import { isRecord } from './request.ts'
import type { PurchaseRequest } from './request.ts'

export interface Problem { code: string; message: string }

export interface EvidenceCheckInput {
  /** A copy of the request (already shape-checked). */
  request: PurchaseRequest
  /** A copy of the evidence supplied under this check's name. Never undefined: absence is refused before the check runs. */
  evidence: unknown
  /** sha256 hex of the RFC 8785 JCS form of the request, as in the decision receipt. */
  action_ref: string
  agent_id: string
  /** The gate's clock for this decision. */
  now: Date
}

export interface EvidenceCheckResult {
  /** Every reason this evidence does not allow the request. Empty = it allows it. */
  problems: Problem[]
  /** An id for the evidence checked (an event id, a digest), recorded in the decision evidence. Null when there is none. */
  evidence_id: string | null
}

export interface EvidenceCheck {
  /** The key the caller supplies this evidence under, and the name recorded with the decision. [a-z0-9_]+ */
  name: string
  check(input: EvidenceCheckInput): EvidenceCheckResult
}

/** What a decision records per configured check: its name and the id the check returned (null if it never returned one). */
export interface CheckedEvidence { check: string; evidence_id: string | null }

export const CHECK_NAME = /^[a-z0-9_]+$/

/** Names an evidence map could resolve through Object.prototype (__proto__, constructor, ...). Refused as check names. */
const RESERVED = (name: string): boolean => Object.prototype.hasOwnProperty.call(Object.prototype, name)

/** Validates the configured checks and returns a frozen copy of each {name, check}, read once, so a getter on the
 *  caller's object cannot change a name or a function after the gate opens. The function stays bound to its object. Throws on a configuration the gate should
 *  not open with. */
export function validateChecks(checks: readonly EvidenceCheck[]): readonly EvidenceCheck[] {
  if (!Array.isArray(checks)) throw new Error('evidenceChecks must be an array')
  const seen = new Set<string>()
  const out: EvidenceCheck[] = []
  for (const c of checks) {
    const name: unknown = isRecord(c) ? c.name : undefined
    const check: unknown = isRecord(c) ? c.check : undefined
    if (typeof name !== 'string' || !CHECK_NAME.test(name) || typeof check !== 'function') {
      throw new Error('each evidence check needs a name matching [a-z0-9_]+ and a check function')
    }
    if (RESERVED(name)) throw new Error(`evidence check name ${name} is reserved`)
    if (seen.has(name)) throw new Error(`evidence check ${name} is configured twice`)
    seen.add(name)
    // Bound to the object it came from, so a class-based adapter keeps its own `this`.
    out.push(Object.freeze({ name, check: (check as EvidenceCheck['check']).bind(c) }))
  }
  return Object.freeze(out)
}

/** A description of a thrown value that cannot itself throw. */
function describe(e: unknown): string {
  try {
    if (e instanceof Error) return String(e.message)
    return String(e)
  } catch {
    return 'an unprintable value'
  }
}

/** Reads a check's return value once and copies it into plain data. Anything else (a non-object, a throwing getter or
 *  Proxy, a sparse or non-array problems list, a problem without a non-empty string code and a string message, an
 *  evidence_id that is neither null nor a string) is a malformed result. Throws only into runCheck's guard. */
function normalize(r: unknown): EvidenceCheckResult | null {
  if (!isRecord(r)) return null
  const problems: unknown = r.problems
  const evidenceId: unknown = r.evidence_id
  if (!Array.isArray(problems)) return null
  if (!(evidenceId === null || typeof evidenceId === 'string')) return null
  const length: unknown = problems.length
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return null
  const out: Problem[] = []
  for (let i = 0; i < length; i++) {
    if (!Object.hasOwn(problems, i)) return null
    const p: unknown = problems[i]
    if (!isRecord(p)) return null
    const code: unknown = p.code
    const message: unknown = p.message
    if (typeof code !== 'string' || code.length === 0 || typeof message !== 'string') return null
    out.push({ code, message })
  }
  return { problems: out, evidence_id: evidenceId }
}

/** Runs one check and turns absence, a throw or a malformed return into a refusal. The call, the inspection of its
 *  result and the copy are all inside one guard, so no return value can make decide() throw. */
export function runCheck(c: EvidenceCheck, input: Omit<EvidenceCheckInput, 'evidence'>, evidence: unknown): { problems: Problem[]; checked: CheckedEvidence } {
  const checked: CheckedEvidence = { check: c.name, evidence_id: null }
  if (evidence === undefined) {
    return { problems: [{ code: 'evidence_missing', message: `this gate requires ${c.name} evidence` }], checked }
  }
  let r: EvidenceCheckResult | null
  try {
    r = normalize(c.check({ ...input, evidence }))
  } catch (e) {
    return { problems: [{ code: 'evidence_check_failed', message: `${c.name} check threw: ${describe(e)}` }], checked }
  }
  if (r === null) {
    return { problems: [{ code: 'evidence_check_failed', message: `${c.name} check returned a malformed result` }], checked }
  }
  checked.evidence_id = r.evidence_id
  return { problems: r.problems, checked }
}
