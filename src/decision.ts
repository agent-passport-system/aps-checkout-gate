// The gate's decision record. Every decision, permit or refuse, is signed with
// the gate's Ed25519 key over the RFC 8785 (JCS) form of the record without its
// signature field. Signing and verification are the SDK's sign and verify, the
// same pattern as noncommercial-access-demo/src/access-condition.ts, with
// canonicalizeJCS in place of the legacy canonicalize.
//
// This record is this sandbox's own profile, aps-checkout-gate/decision-v1. It
// is not an aps:policy-decision:v1 receipt.

import { randomBytes } from 'node:crypto'
import { canonicalizeJCS, sign, verify } from 'agent-passport-system'
import { isRecord } from './request.ts'

export const DECISION_PROFILE = 'aps-checkout-gate/decision-v1'

export type Verdict = 'permit' | 'refuse'

export interface DecisionBody {
  profile: typeof DECISION_PROFILE
  decision_id: string
  verdict: Verdict
  /** 'permitted' on a permit. On a refusal, the first refusal code. */
  reason: string
  /** Every problem found, in check order. Empty on a permit. */
  detail: string[]
  request_id: string | null
  /** sha256 of the JCS form of the request. Null when the request could not be canonicalized. */
  request_digest: string | null
  /** The delegation_id of the grant. Null when the input carried none. */
  grant_id: string | null
  /** Set only on a permit. */
  reservation_id: string | null
  gate_id: string
  gate_key_id: string
  decided_at: string
}

export interface DecisionRecord extends DecisionBody {
  /** Ed25519 over canonicalizeJCS(body), 128 lowercase hex characters. */
  signature: string
}

const BODY_KEYS = [
  'decided_at', 'decision_id', 'detail', 'gate_id', 'gate_key_id', 'grant_id', 'profile', 'reason',
  'request_digest', 'request_id', 'reservation_id', 'verdict',
]

export const newDecisionId = () => `dec_${randomBytes(16).toString('hex')}`

export function signDecision(body: DecisionBody, gatePrivateKey: string): DecisionRecord {
  return { ...body, signature: sign(canonicalizeJCS(body), gatePrivateKey) }
}

/** Checks a decision record against a gate public key the caller trusts. */
export function verifyDecision(record: unknown, gatePublicKey: string): { valid: boolean; problems: string[] } {
  if (!isRecord(record)) return { valid: false, problems: ['decision record is not an object'] }
  const { signature, ...body } = record
  const problems: string[] = []
  const keys = Object.keys(body).sort()
  if (keys.length !== BODY_KEYS.length || !keys.every((k, i) => k === BODY_KEYS[i])) {
    problems.push('decision record does not have exactly the decision-v1 fields')
  }
  if (body.profile !== DECISION_PROFILE) problems.push('decision record has an unknown profile')
  if (body.verdict !== 'permit' && body.verdict !== 'refuse') problems.push('decision verdict is neither permit nor refuse')
  if (body.verdict === 'permit' && (body.reason !== 'permitted' || typeof body.reservation_id !== 'string')) {
    problems.push('a permit must carry reason permitted and a reservation id')
  }
  if (body.verdict === 'refuse' && body.reservation_id !== null) problems.push('a refusal must not carry a reservation id')
  let ok = false
  try {
    ok = typeof signature === 'string' && verify(canonicalizeJCS(body), signature, gatePublicKey)
  } catch {
    ok = false
  }
  if (!ok) problems.push('decision signature does not verify under the gate key')
  return { valid: problems.length === 0, problems }
}
