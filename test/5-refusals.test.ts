import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UNVERIFIED_INTENT, UNVERIFIED_INTENT_REF } from '../src/decision.ts'
import { makeParty } from '../src/parties.ts'
import { requestDigest } from '../src/request.ts'
import { issueGrant, purchaseGrant } from '../src/delegation.ts'
import { MERCHANT, control, expectRefusal, world } from './helpers.ts'

test('5. expired grant is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ ttl_ms: 3600_000 })
  control(w, gate, grant)
  w.clock.t += 2 * 3600_000
  expectRefusal(w, gate, w.input(w.request(), grant), 'grant_expired')
})

test('5. revoked grant is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  gate.revoke(grant.delegation_id, 'principal withdrew the grant')
  expectRefusal(w, gate, w.input(w.request(), grant), 'grant_revoked')
  // The revocation list is durable.
  gate.close()
  expectRefusal(w, w.open(), w.input(w.request(), grant), 'grant_revoked')
})

test('5. merchant out of scope is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  expectRefusal(w, gate, w.input(w.request({ merchant_id: 'merchant-b' }), grant), 'out_of_scope')
})

test('5. action out of scope is refused: a refund grant does not cover purchase', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  control(w, gate, w.grant())
  const refundOnly = w.grant({ grants: [`checkout:${MERCHANT}:refund`] })
  expectRefusal(w, gate, w.input(w.request(), refundOnly), 'out_of_scope')
})

test('5. amount over the per-request limit is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 20_000 })
  control(w, gate, grant)
  const ok = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant))
  assert.equal(ok.verdict, 'permit', 'exactly the per-request limit is allowed')
  expectRefusal(w, gate, w.input(w.request({ amount_minor: 5001 }), grant), 'per_request_limit_exceeded')
})

test('5. intent signed by a different agent is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  // agent B is a trusted agent key, but the request and the grant are agent A's.
  expectRefusal(w, gate, w.input(w.request(), grant, w.agentB), 'intent_signer_mismatch')
})

test('5. intent for a different amount is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  const req = w.request({ amount_minor: 2000 })
  expectRefusal(w, gate, w.input(req, grant, w.agent, { ...req, amount_minor: 1000 }), 'intent_request_mismatch')
})

test('5. other refusals: currency, grant subject, untrusted principal, tampered grant, float money', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  expectRefusal(w, gate, w.input(w.request({ currency: 'EUR' }), grant), 'currency_mismatch')
  expectRefusal(w, gate, w.input(w.request(), w.grant({}, w.agentB)), 'agent_not_delegated')
  const stranger = makeParty('did:example:stranger', 'principal')
  const foreign = issueGrant(stranger, w.agent, { grants: [purchaseGrant(MERCHANT)], currency: 'USD', per_action_minor: 10_000, cumulative_minor: 10_000, issued_at: new Date(w.clock.t) })
  expectRefusal(w, gate, w.input(w.request(), foreign), 'delegation_invalid')
  const raised = structuredClone(grant)
  ;(raised.authority.spend as { cumulative: string }).cumulative = '99999999'
  expectRefusal(w, gate, w.input(w.request(), raised), 'delegation_invalid')
  expectRefusal(w, gate, w.input(w.request({ amount_minor: 10.5 }), grant), 'malformed_request')
  expectRefusal(w, gate, w.input(w.request({ amount_minor: '3000' as never }), grant), 'malformed_request')
})

test('5. a refusal for an intent that does not verify names no agent and no intent', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  // Signed by a key the directory does not hold, under agent A's name.
  const impostor = { ...makeParty('did:example:impostor', 'agent'), id: w.agent.id }
  const req = w.request()
  const input = w.input(req, grant, impostor)
  const r = expectRefusal(w, gate, input, 'intent_invalid')
  assert.equal(r.record.receipt.subject_agent, UNVERIFIED_INTENT)
  assert.equal(r.record.receipt.prev, UNVERIFIED_INTENT_REF)
  assert.notEqual(r.record.receipt.prev, input.intent.receipt_id)
  assert.equal(r.record.evidence.policy_input.intent_receipt_id, null)
  // The action_ref still binds the exact request the gate refused.
  assert.equal(r.record.receipt.action_ref, requestDigest(req))
})

test('5. a missing or malformed delegation, and input that cannot be copied, are refused with a signed record, not thrown', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const inp = w.input(w.request({ amount_minor: 100 }), grant)
  for (const bad of [
    { ...inp, delegation: undefined },
    { ...inp, delegation: { ...grant, delegation_id: 'not-a-ref' } },
    { ...inp, intent: (() => 1) as never },
  ]) {
    const r = gate.decide(bad as never)
    assert.equal(r.verdict, 'deny')
    assert.deepEqual(w.verifies(r.record), { valid: true, problems: [] })
  }
})
