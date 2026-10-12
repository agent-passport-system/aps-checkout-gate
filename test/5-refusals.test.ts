import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthorityDelegationV1 } from 'agent-passport-system'
import { verifyDecision } from '../src/decision.ts'
import type { Gate } from '../src/gate.ts'
import { makeParty } from '../src/parties.ts'
import type { PurchaseRequest } from '../src/request.ts'
import { issueGrant, purchaseGrant } from '../src/delegation.ts'
import { MERCHANT, world } from './helpers.ts'
import type { World } from './helpers.ts'

/** Each case first shows a control request that the same gate permits, then
 *  changes one thing and expects a signed refusal with no reservation. */
function expectRefusal(w: World, gate: Gate, input: Parameters<Gate['decide']>[0], reason: string) {
  const { record } = gate.decide(input)
  assert.equal(record.verdict, 'refuse', `expected a refusal for ${reason}, got ${record.verdict}`)
  assert.equal(record.reason, reason, record.detail.join(' | '))
  assert.equal(record.reservation_id, null)
  assert.deepEqual(verifyDecision(record, w.gateParty.publicKey), { valid: true, problems: [] })
  const req = input.request as PurchaseRequest
  assert.equal(gate.reservationForRequest(req.request_id), undefined, 'a refusal must not reserve')
  assert.deepEqual(gate.decisionsForRequest(req.request_id), [record], 'the refusal is stored')
  return record
}

function control(w: World, gate: Gate, grant: AuthorityDelegationV1) {
  const { record } = gate.decide(w.input(w.request({ amount_minor: 100 }), grant))
  assert.equal(record.verdict, 'permit', `control was refused: ${record.detail.join(' | ')}`)
}

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
  const ok = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant)).record
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
