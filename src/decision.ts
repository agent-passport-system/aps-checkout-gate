// The gate's decision record, an aps:policy-decision:v1 receipt built with the
// SDK: createReceiptV1 with a decision_ref from buildDecisionRefV1 and an
// aps-core-decision-output-v1 result. Every decision, permit or deny, is one.
//
// The receipt schema is closed and its result must be exactly the core decision
// output, so the receipt cannot carry the reservation id or the refusal reasons
// as fields. They live in the decision evidence (decision_context), which the
// receipt commits to through decision_ref. A verifier checks the pair with
// verifyReceiptWithDecisionV1, and the gate stores the pair.
//
// action_ref is the request digest, sha256 over the JCS form of the request,
// the same value the agent's intent commits to (request.ts requestDigest). It
// is not the SDK's computeActionRefV2.

import { buildDecisionRefV1, createReceiptV1, verifyReceiptV1, verifyReceiptWithDecisionV1 } from 'agent-passport-system'
import type { ReceiptV1 } from 'agent-passport-system'
import { keyId } from './parties.ts'
import type { Party } from './parties.ts'
import { isRecord, sha256Hex } from './request.ts'

export type Verdict = 'permit' | 'deny'

export interface CoreDecisionOutput {
  profile: 'aps-core-decision-output-v1'
  verdict: Verdict
  /** The grant's digest on a permit, null on a deny. */
  effective_authority_ref: string | null
  constraints: string[]
  /** On a permit, the time after which startup recovery may move the reservation
   *  to unresolved. Null on a deny. */
  valid_until: string | null
}

export const CONTEXT_PROFILE = 'aps-checkout-gate/decision-context-v1'

/** Everything decision_ref commits to besides action_ref and the output. */
export interface DecisionEvidence {
  authority_state: {
    grant_id: string | null
    spend_unit: string | null
    cumulative_minor: string | null
    /** Reserved, committed and unresolved minor units for the grant before this decision. Null when the budget was not read. */
    held_minor_before: string | null
  }
  policy_input: {
    request_id: string | null
    request_digest: string | null
    intent_receipt_id: string | null
    /** False when the line items carried no prices, so the amount was not cross-checked. Null when not evaluated. */
    items_priced: boolean | null
    /** Present only when the gate has evidence checks: per check, its name and the id of the evidence it checked, or null. */
    required_evidence?: { check: string; evidence_id: string | null }[]
  }
  decision_context: {
    profile: typeof CONTEXT_PROFILE
    /** 'permitted' on a permit, otherwise the first refusal code. */
    reason: string
    /** Every problem found, in check order. Empty on a permit. */
    reasons: string[]
    /** Set only on a permit. */
    reservation_id: string | null
    gate_id: string
  }
  decision_output: CoreDecisionOutput
}

export interface DecisionRecord {
  receipt: ReceiptV1
  evidence: DecisionEvidence
}

/** What a refusal cites in place of the intent when the intent did not verify. */
export const UNVERIFIED_INTENT = 'unverified-intent'
export const UNVERIFIED_INTENT_REF = sha256Hex(UNVERIFIED_INTENT)
/** action_ref of a refusal whose input could not be canonicalized at all. */
export const UNCANONICAL_REQUEST_REF = sha256Hex('uncanonicalizable-request')

export interface IssueArgs {
  action_ref: string
  /** The verified intent's receipt_id, or UNVERIFIED_INTENT_REF. */
  prev: string
  /** The verified intent's subject_agent, or UNVERIFIED_INTENT. */
  subject_agent: string
  delegation_ref: string
  issued_at: string
  evidence: DecisionEvidence
}

export function issueDecision(gate: Party, a: IssueArgs): DecisionRecord {
  const { decision_ref } = buildDecisionRefV1({
    action_ref: a.action_ref,
    authority_state: a.evidence.authority_state as never,
    policy_input: a.evidence.policy_input as never,
    decision_context: a.evidence.decision_context as never,
    decision_output: a.evidence.decision_output,
  })
  const receipt = createReceiptV1(
    {
      profile: 'aps-receipt-v1',
      receipt_type: 'aps:policy-decision:v1',
      issuer: gate.id,
      subject_agent: a.subject_agent,
      action_ref: a.action_ref,
      delegation_ref: a.delegation_ref,
      decision_ref,
      prev: a.prev,
      issued_at: a.issued_at,
      evidence_refs: [],
      result: a.evidence.decision_output as never,
    },
    [{ signer: gate.id, key_id: keyId(gate.id), private_key: gate.privateKey }],
  )
  return { receipt, evidence: a.evidence }
}

export const verdictOf = (r: DecisionRecord): Verdict => r.evidence.decision_output.verdict
export const reasonOf = (r: DecisionRecord): string => r.evidence.decision_context.reason
export const reservationOf = (r: DecisionRecord): string | null => r.evidence.decision_context.reservation_id

/** Checks a decision record against a gate identity and public key the caller
 *  trusts: verifyReceiptV1 for the signature, closed schema and policy-decision
 *  stage rules, verifyReceiptWithDecisionV1 for the decision_ref binding of the
 *  evidence, and this gate's own rule that a permit carries a reservation and a
 *  deny does not. */
export function verifyDecision(record: unknown, gateId: string, gatePublicKey: string): { valid: boolean; problems: string[] } {
  if (!isRecord(record) || Object.keys(record).sort().join(',') !== 'evidence,receipt' || !isRecord(record.receipt) || !isRecord(record.evidence)) {
    return { valid: false, problems: ['decision record is not exactly {receipt, evidence}'] }
  }
  const receipt = record.receipt as unknown as ReceiptV1
  const evidence = record.evidence as unknown as DecisionEvidence
  const resolve = (signer: string) => (signer === gateId ? gatePublicKey : undefined)
  const problems: string[] = []
  const opts = { boundaryIdentity: gateId, expectedReceiptType: 'aps:policy-decision:v1' }
  try {
    const rv = verifyReceiptV1(receipt, resolve, opts)
    if (!rv.valid) problems.push(`receipt ${rv.status}: ${rv.errors.join(' | ')}`)
    const cv = verifyReceiptWithDecisionV1(receipt, evidence as never, resolve, opts)
    if (!cv.valid) problems.push(`receipt with decision ${cv.status}: ${cv.errors.join(' | ')}`)
  } catch (e) {
    problems.push(`receipt could not be checked: ${e instanceof Error ? e.message : String(e)}`)
  }
  const ctx = isRecord(evidence.decision_context) ? evidence.decision_context : undefined
  const out = isRecord(evidence.decision_output) ? evidence.decision_output : undefined
  if (!ctx || ctx.profile !== CONTEXT_PROFILE || ctx.gate_id !== gateId) problems.push('decision context is not this gate\'s')
  else if (out?.verdict === 'permit' && (ctx.reason !== 'permitted' || typeof ctx.reservation_id !== 'string')) {
    problems.push('a permit must carry reason permitted and a reservation id')
  } else if (out?.verdict === 'deny' && (ctx.reservation_id !== null || ctx.reason === 'permitted')) {
    problems.push('a deny must carry a refusal reason and no reservation id')
  }
  return { valid: problems.length === 0, problems }
}
