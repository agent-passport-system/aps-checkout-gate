import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyReceiptV1 } from 'agent-passport-system'
import { requestDigest } from '../src/request.ts'
import { world } from './helpers.ts'

test('1. happy path: permit, reservation reserved, outcome placed moves it to committed', t => {
  const w = world()
  t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 10_000 })
  const req = w.request({ amount_minor: 3000 })
  const input = w.input(req, grant)

  const r = gate.decide(input)
  assert.equal(r.replay, false)
  assert.equal(r.verdict, 'permit')
  assert.equal(r.reason, 'permitted')
  assert.ok(r.reservation_id)

  // The decision is an aps:policy-decision:v1 receipt that verifies with the SDK.
  const { receipt, evidence } = r.record
  assert.equal(receipt.receipt_type, 'aps:policy-decision:v1')
  assert.equal(receipt.issuer, w.gateParty.id)
  const rv = verifyReceiptV1(receipt, s => (s === w.gateParty.id ? w.gateParty.publicKey : undefined), { boundaryIdentity: w.gateParty.id })
  assert.equal(rv.valid, true, rv.errors.join(' | '))
  assert.deepEqual(w.verifies(r.record), { valid: true, problems: [] })
  // It binds the exact request, answers the agent's intent and names the grant.
  assert.equal(receipt.action_ref, requestDigest(req))
  assert.equal(receipt.action_ref, input.intent.action_ref)
  assert.equal(receipt.prev, input.intent.receipt_id)
  assert.equal(receipt.subject_agent, w.agent.id)
  assert.equal(receipt.delegation_ref, grant.delegation_id)
  assert.equal(receipt.result.verdict, 'permit')
  assert.equal(receipt.result.effective_authority_ref, grant.delegation_id.replace(/^sha256:/, ''))
  assert.equal(evidence.decision_context.reservation_id, r.reservation_id)
  assert.equal(evidence.authority_state.grant_id, grant.delegation_id)
  assert.equal(evidence.authority_state.held_minor_before, '0')
  assert.equal(evidence.policy_input.items_priced, true)

  const res = gate.reservation(r.reservation_id!)
  assert.equal(res?.state, 'reserved')
  assert.equal(res?.amount_minor, 3000)
  assert.equal(res?.unit, 'iso4217:USD:minor')
  assert.equal(gate.budget(grant.delegation_id).held, '3000')

  assert.deepEqual(gate.reportOutcome(r.reservation_id!, 'placed', { platform_ref: 'order-77' }),
    { ok: true, code: 'recorded', state: 'committed' })
  assert.equal(gate.reservation(r.reservation_id!)?.state, 'committed')
  const b = gate.budget(grant.delegation_id)
  assert.equal(b.committed, '3000')
  assert.equal(b.reserved, '0')
  assert.equal(b.held, '3000')

  // The decision is stored and survives a reopen of the same file.
  gate.close()
  const again = w.open()
  assert.deepEqual(again.decision(receipt.receipt_id), r.record)
  assert.equal(again.reservation(r.reservation_id!)?.state, 'committed')

  // A committed reservation cannot be moved by another outcome report.
  assert.deepEqual(again.reportOutcome(r.reservation_id!, 'failed', { platform_ref: 'x' }),
    { ok: false, code: 'invalid_state', state: 'committed' })
})
