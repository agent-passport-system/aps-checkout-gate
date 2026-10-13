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

const isProblem = (p: unknown): p is Problem =>
  isRecord(p) && typeof p.code === 'string' && p.code.length > 0 && typeof p.message === 'string'

/** Throws on a configuration the gate should not open with. */
export function validateChecks(checks: readonly EvidenceCheck[]): void {
  const seen = new Set<string>()
  for (const c of checks) {
    if (!isRecord(c) || typeof c.name !== 'string' || !CHECK_NAME.test(c.name) || typeof c.check !== 'function') {
      throw new Error('each evidence check needs a name matching [a-z0-9_]+ and a check function')
    }
    if (seen.has(c.name)) throw new Error(`evidence check ${c.name} is configured twice`)
    seen.add(c.name)
  }
}

/** Runs one check and turns absence, a throw or a malformed return into a refusal. */
export function runCheck(c: EvidenceCheck, input: Omit<EvidenceCheckInput, 'evidence'>, evidence: unknown): { problems: Problem[]; checked: CheckedEvidence } {
  const checked: CheckedEvidence = { check: c.name, evidence_id: null }
  if (evidence === undefined) {
    return { problems: [{ code: 'evidence_missing', message: `this gate requires ${c.name} evidence` }], checked }
  }
  let r: unknown
  try {
    r = c.check({ ...input, evidence })
  } catch (e) {
    return { problems: [{ code: 'evidence_check_failed', message: `${c.name} check threw: ${e instanceof Error ? e.message : String(e)}` }], checked }
  }
  if (!isRecord(r) || !Array.isArray(r.problems) || !r.problems.every(isProblem) ||
      !(r.evidence_id === null || typeof r.evidence_id === 'string')) {
    return { problems: [{ code: 'evidence_check_failed', message: `${c.name} check returned a malformed result` }], checked }
  }
  checked.evidence_id = r.evidence_id
  return { problems: r.problems.map(p => ({ code: p.code, message: p.message })), checked }
}
