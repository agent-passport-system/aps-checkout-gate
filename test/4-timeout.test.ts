import assert from 'node:assert/strict'
import { test } from 'node:test'
import { world } from './helpers.ts'

for (const outcome of ['timeout', 'unknown'] as const) {
  test(`4. ${outcome}: reservation becomes unresolved, budget held, reconcile failed releases it`, t => {
    const w = world()
    t.after(() => w.cleanup())
    const gate = w.open()
    const grant = w.grant({ per_action_minor: 10_000, cumulative_minor: 10_000 })
    const first = gate.decide(w.input(w.request({ amount_minor: 6000 }), grant)).record
    assert.equal(first.verdict, 'permit')
    const rid = first.reservation_id!

    assert.deepEqual(gate.reportOutcome(rid, outcome), { ok: true, code: 'recorded', state: 'unresolved' })
    assert.equal(gate.budget(grant.delegation_id).held, '6000')

    // Budget is held: 6000 + 5000 is over 10000.
    const blocked = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant)).record
    assert.equal(blocked.verdict, 'refuse')
    assert.equal(blocked.reason, 'budget_exceeded')

    // Time passing releases nothing.
    w.clock.t += 24 * 3600_000
    assert.equal(gate.reservation(rid)?.state, 'unresolved')
    gate.close()
    const reopened = w.open({ recoveryWindowMs: 0 })
    assert.equal(reopened.reservation(rid)?.state, 'unresolved')
    assert.equal(reopened.budget(grant.delegation_id).held, '6000')

    // Only reconcile, with confirmation, moves it.
    assert.equal(reopened.reportOutcome(rid, 'failed', { platform_ref: 'p-1' }).code, 'invalid_state')
    assert.deepEqual(reopened.reconcile(rid, { outcome: 'failed', confirmation: { platform_ref: 'p-1' } }),
      { ok: true, code: 'reconciled', state: 'released' })
    assert.equal(reopened.budget(grant.delegation_id).held, '0')
    assert.equal(reopened.budget(grant.delegation_id).released, '6000')
  })
}

test('4b. budget freed by reconcile can be reserved again', t => {
  const w = world()
  t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 10_000, cumulative_minor: 10_000 })
  const rid = gate.decide(w.input(w.request({ amount_minor: 6000 }), grant)).record.reservation_id!
  gate.reportOutcome(rid, 'timeout')
  assert.equal(gate.decide(w.input(w.request({ amount_minor: 5000 }), grant)).record.reason, 'budget_exceeded')
  gate.reconcile(rid, { outcome: 'failed', confirmation: { platform_ref: 'p-2' } })
  const again = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant)).record
  assert.equal(again.verdict, 'permit')
})

test('4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release', t => {
  const w = world()
  t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const a = gate.decide(w.input(w.request({ amount_minor: 2000 }), grant)).record.reservation_id!
  const b = gate.decide(w.input(w.request({ amount_minor: 2000 }), grant)).record.reservation_id!
  assert.equal(gate.reportOutcome(a, 'unknown').state, 'unresolved')
  assert.equal(gate.reconcile(a, { outcome: 'placed', confirmation: { platform_ref: 'ord-9' } }).state, 'committed')
  // A failure report with no platform confirmation is not a confirmed failure.
  assert.equal(gate.reportOutcome(b, 'failed').state, 'unresolved')
  assert.equal(gate.budget(grant.delegation_id).held, '4000')
  // reconcile only acts on unresolved reservations.
  assert.equal(gate.reconcile(a, { outcome: 'failed', confirmation: { platform_ref: 'x' } }).code, 'invalid_state')
})
