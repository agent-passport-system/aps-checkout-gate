// A real invinoveritas /review verdict drives a permit end to end through decide().
//
// test/vectors/invinoveritas-verdict-64607ef8.json was signed by invinoveritas on 2026-10-14 over the same
// synthetic order as invinoveritas-verdict-b2cd036a.json, with merchant_id changed from "merchant:example-store"
// to "example-store" (aeoess/agent-governance-vocabulary#199). The older vector stays as a refusal regression:
// its merchant id holds a colon, so it cannot be one scope segment and decide() refuses the request before any
// evidence check runs. Synthetic order, demo keys for the principal, agent and gate, no payment.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyDecision } from '../src/decision.ts'
import { issueGrant, purchaseGrant } from '../src/delegation.ts'
import { Gate } from '../src/gate.ts'
import { makeParty, trustedKeys } from '../src/parties.ts'
import { requestDigest, signIntent } from '../src/request.ts'
import type { PurchaseRequest } from '../src/request.ts'
import { verdictCheck } from '../src/verdict.ts'
import type { NostrEvent } from '../src/verdict.ts'

interface Vector { request: PurchaseRequest; action_ref: string; event: NostrEvent }
const load = (name: string): Vector => JSON.parse(readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8'))
const LIVE = load('invinoveritas-verdict-64607ef8.json')
const OLD = load('invinoveritas-verdict-b2cd036a.json')
const verifiedAt = (v: Vector): number => JSON.parse(v.event.content).verified_at * 1000

/** A gate whose clock sits one second after the verdict was signed, with the vector's agent id as a trusted agent
 *  and a grant for the vector's merchant. Only the verdict comes from outside; every other key is generated here. */
function setup(t: { after(fn: () => void): void }, v: Vector, proceedOn: string[], merchant = v.request.merchant_id) {
  const dir = mkdtempSync(join(tmpdir(), 'aps-checkout-gate-live-'))
  const at = new Date(verifiedAt(v) + 1000)
  const gateParty = makeParty('did:example:gate', 'gate')
  const principal = makeParty('did:example:buyer', 'principal')
  const shopper = makeParty(v.request.agent_id, 'agent')
  const gate = Gate.open({
    dbPath: join(dir, 'gate.db'), gate: gateParty, directory: trustedKeys([gateParty, principal, shopper]), now: () => at,
    evidenceChecks: [verdictCheck({ verifierPubkey: v.event.pubkey, proceedOn })],
  })
  t.after(() => { try { gate.close() } catch { /* closed already */ } rmSync(dir, { recursive: true, force: true }) })
  const grant = issueGrant(principal, shopper, {
    grants: [purchaseGrant(merchant)], currency: 'USD', per_action_minor: 10_000, cumulative_minor: 10_000, issued_at: at,
  })
  const input = { request: v.request, delegation: grant, intent: signIntent(v.request, shopper, grant, at), evidence: { verdict: v.event } }
  return { gate, gateParty, shopper, at, input }
}

test('16. the vectors differ only in merchant_id, and each action_ref recomputes', () => {
  const changed = Object.keys({ ...LIVE.request, ...OLD.request })
    .filter(k => JSON.stringify((LIVE.request as unknown as Record<string, unknown>)[k]) !== JSON.stringify((OLD.request as unknown as Record<string, unknown>)[k]))
  assert.deepEqual(changed, ['merchant_id'])
  assert.equal(requestDigest(LIVE.request), LIVE.action_ref)
  assert.equal(requestDigest(OLD.request), OLD.action_ref)
  assert.equal(JSON.parse(LIVE.event.content).action_binding_args_hash, 'sha256:' + LIVE.action_ref)
})

test('16. the live verdict permits through decide() and the signed permit cites it', t => {
  const { gate, gateParty, input } = setup(t, LIVE, ['approve', 'approve_with_concerns'])
  const r = gate.decide(input)
  assert.equal(r.verdict, 'permit', r.record.evidence.decision_context.reasons.join(' | '))
  assert.ok(r.reservation_id, 'a permit reserves budget')
  assert.deepEqual(r.record.evidence.policy_input.required_evidence, [{ check: 'verdict', evidence_id: LIVE.event.id }])
  assert.deepEqual(verifyDecision(r.record, gateParty.id, gateParty.publicKey), { valid: true, problems: [] })
})

test('16. the same live verdict is refused when the store accepts only approve', t => {
  const { gate, input } = setup(t, LIVE, ['approve'])
  const r = gate.decide(input)
  assert.equal(r.verdict, 'deny')
  assert.equal(r.reason, 'verdict_not_allowed')
  assert.equal(r.reservation_id, null)
})

test('16. the live verdict does not carry over to another order', t => {
  const { gate, shopper, at, input } = setup(t, LIVE, ['approve', 'approve_with_concerns'])
  const other = { ...LIVE.request, request_id: 'req-0002', order_ref: 'order-1043' }
  const r = gate.decide({ ...input, request: other, intent: signIntent(other, shopper, input.delegation, at) })
  assert.equal(r.verdict, 'deny')
  assert.equal(r.reason, 'verdict_request_mismatch')
  assert.equal(r.reservation_id, null)
})

test('16. regression: the 2026-10-12 vector is refused as malformed_request, before evidence is read', t => {
  // A grant cannot name this merchant as a valid segment, so the grant uses the live merchant. The refusal must
  // come from the request shape, not from the grant or the verdict.
  const { gate, input } = setup(t, OLD, ['approve', 'approve_with_concerns'], 'example-store')
  const r = gate.decide(input)
  assert.equal(r.verdict, 'deny')
  assert.equal(r.reason, 'malformed_request')
  assert.equal(r.reservation_id, null)
  assert.match(r.record.evidence.decision_context.reasons.join(' | '), /merchant_id is not a valid scope segment/)
})
