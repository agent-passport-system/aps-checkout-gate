import assert from 'node:assert/strict'
import { test } from 'node:test'
import { world } from './helpers.ts'

test('6. idempotent replay of a permit returns the same receipt and reserves once', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const req = w.request({ amount_minor: 4000 })
  const first = gate.decide(w.input(req, grant))
  assert.equal(first.verdict, 'permit')

  // Same input again, and the same request with a freshly signed intent.
  const again = gate.decide(w.input(req, grant))
  w.clock.t += 1000
  const resigned = gate.decide(w.input(structuredClone(req), grant))
  for (const r of [again, resigned]) {
    assert.equal(r.replay, true)
    assert.deepEqual(r.record, first.record)
  }
  assert.equal(gate.budget(grant.delegation_id).held, '4000', 'one reservation, not three')
  assert.deepEqual(gate.decisionsForRequest(req.request_id), [first.record])

  // Across a reopen of the same file, too.
  gate.close()
  const reopened = w.open()
  const later = reopened.decide(w.input(req, grant))
  assert.equal(later.replay, true)
  assert.deepEqual(later.record, first.record)
  assert.equal(reopened.budget(grant.delegation_id).held, '4000')
})

test('6. a refusal is not an idempotency answer: budget_exceeded turns into a permit once budget is released', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 5000 })
  const holder = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant))
  assert.equal(holder.verdict, 'permit')

  const req = w.request({ amount_minor: 3000 })
  const input = w.input(req, grant)
  const refused = gate.decide(input)
  assert.equal(refused.reason, 'budget_exceeded')
  // Still no budget: the same request is evaluated again and refused again,
  // as a new signed receipt (a later issued_at gives a new receipt_id).
  w.clock.t += 1000
  const refusedAgain = gate.decide(input)
  assert.equal(refusedAgain.replay, false)
  assert.equal(refusedAgain.reason, 'budget_exceeded')
  assert.notEqual(refusedAgain.record.receipt.receipt_id, refused.record.receipt.receipt_id)

  // Release the holder's budget through the only path that releases it.
  gate.reportOutcome(holder.reservation_id!, 'timeout')
  gate.reconcile(holder.reservation_id!, { outcome: 'failed', confirmation: { platform_ref: 'declined-1' } })

  // Identical content under the same request_id now gets a permit.
  const permitted = gate.decide(input)
  assert.equal(permitted.replay, false)
  assert.equal(permitted.verdict, 'permit')
  assert.deepEqual(w.verifies(permitted.record).valid, true)
  // From here on the permit is the answer.
  const replay = gate.decide(input)
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.record, permitted.record)
  assert.equal(gate.budget(grant.delegation_id).held, '3000')
  // The log keeps both refusals and the permit.
  assert.deepEqual(gate.decisionsForRequest(req.request_id).map(d => d.evidence.decision_output.verdict), ['deny', 'deny', 'permit'])
})

test('6. different content under a request_id that holds only refusals is evaluated as a new request', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 10_000 })
  const req = w.request({ amount_minor: 6000 })
  assert.equal(gate.decide(w.input(req, grant)).reason, 'per_request_limit_exceeded')
  const fixed = { ...req, amount_minor: 4000, items: [{ sku: 'sku-1', quantity: 1, unit_price_minor: 4000 }] }
  const r = gate.decide(w.input(fixed, grant))
  assert.equal(r.verdict, 'permit')
})

test('6. conflicting replay: different content under a request_id that holds a permit is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const req = w.request({ amount_minor: 3000 })
  const first = gate.decide(w.input(req, grant))
  assert.equal(first.verdict, 'permit')

  for (const changed of [{ ...req, amount_minor: 3001 }, { ...req, order_ref: 'other-order' }]) {
    // The new content carries its own valid intent. Only the request_id repeats.
    const r = gate.decide(w.input(changed, grant))
    assert.equal(r.replay, false)
    assert.equal(r.verdict, 'deny')
    assert.equal(r.reason, 'request_id_conflict')
    assert.equal(r.reservation_id, null)
    assert.notEqual(r.record.receipt.action_ref, first.record.receipt.action_ref)
    assert.equal(w.verifies(r.record).valid, true)
  }
  assert.equal(gate.budget(grant.delegation_id).held, '3000')
  assert.equal(gate.reservationForRequest(req.request_id), first.reservation_id)
  // The original answer still stands.
  assert.deepEqual(gate.decide(w.input(req, grant)).record, first.record)
  // Conflicts are logged, the permit stays the idempotency answer.
  assert.equal(gate.decisionsForRequest(req.request_id).length, 3)
})
