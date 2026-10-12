import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyDecision } from '../src/decision.ts'
import { world } from './helpers.ts'

test('1. happy path: permit, reservation reserved, outcome placed moves it to committed', t => {
  const w = world()
  t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 10_000 })
  const req = w.request({ amount_minor: 3000 })

  const { record, replay } = gate.decide(w.input(req, grant))
  assert.equal(replay, false)
  assert.equal(record.verdict, 'permit')
  assert.equal(record.reason, 'permitted')
  assert.equal(record.grant_id, grant.delegation_id)
  assert.equal(record.request_id, req.request_id)
  assert.ok(record.reservation_id)
  assert.deepEqual(verifyDecision(record, w.gateParty.publicKey), { valid: true, problems: [] })

  const res = gate.reservation(record.reservation_id!)
  assert.equal(res?.state, 'reserved')
  assert.equal(res?.amount_minor, 3000)
  assert.equal(res?.unit, 'iso4217:USD:minor')
  assert.equal(gate.budget(grant.delegation_id).held, '3000')

  assert.deepEqual(gate.reportOutcome(record.reservation_id!, 'placed', { platform_ref: 'order-77' }),
    { ok: true, code: 'recorded', state: 'committed' })
  assert.equal(gate.reservation(record.reservation_id!)?.state, 'committed')
  const b = gate.budget(grant.delegation_id)
  assert.equal(b.committed, '3000')
  assert.equal(b.reserved, '0')
  assert.equal(b.held, '3000')

  // The decision is stored and survives a reopen of the same file.
  gate.close()
  const again = w.open()
  assert.deepEqual(again.decision(record.decision_id), record)
  assert.equal(again.reservation(record.reservation_id!)?.state, 'committed')

  // A committed reservation cannot be moved by another outcome report.
  assert.deepEqual(again.reportOutcome(record.reservation_id!, 'failed', { platform_ref: 'x' }),
    { ok: false, code: 'invalid_state', state: 'committed' })
})
