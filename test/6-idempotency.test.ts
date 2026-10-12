import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyDecision } from '../src/decision.ts'
import { world } from './helpers.ts'

test('6. idempotent replay returns the same decision and reserves once', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const req = w.request({ amount_minor: 4000 })
  const first = gate.decide(w.input(req, grant))
  assert.equal(first.record.verdict, 'permit')

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

test('6. a refused request replays as the same refusal', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 5000 })
  const req = w.request({ amount_minor: 6000 })
  const first = gate.decide(w.input(req, grant)).record
  assert.equal(first.reason, 'per_request_limit_exceeded')
  const again = gate.decide(w.input(req, grant))
  assert.equal(again.replay, true)
  assert.deepEqual(again.record, first)
})

test('6. conflicting replay: same request_id, different content, is refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const req = w.request({ amount_minor: 3000 })
  const first = gate.decide(w.input(req, grant)).record
  assert.equal(first.verdict, 'permit')

  for (const changed of [{ ...req, amount_minor: 3001 }, { ...req, order_ref: 'other-order' }]) {
    // The new content carries its own valid intent. Only the request_id repeats.
    const r = gate.decide(w.input(changed, grant))
    assert.equal(r.replay, false)
    assert.equal(r.record.verdict, 'refuse')
    assert.equal(r.record.reason, 'request_id_conflict')
    assert.equal(r.record.reservation_id, null)
    assert.notEqual(r.record.request_digest, first.request_digest)
    assert.deepEqual(verifyDecision(r.record, w.gateParty.publicKey).valid, true)
  }
  assert.equal(gate.budget(grant.delegation_id).held, '3000')
  assert.equal(gate.reservationForRequest(req.request_id), first.reservation_id)
  // The original answer still stands.
  assert.deepEqual(gate.decide(w.input(req, grant)).record, first)
  // Conflicts are logged, the original stays the idempotency answer.
  assert.equal(gate.decisionsForRequest(req.request_id).length, 3)
})
