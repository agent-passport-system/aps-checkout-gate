import assert from 'node:assert/strict'
import { test } from 'node:test'
import { control, expectRefusal, world } from './helpers.ts'

test('9. priced line items must sum to amount_minor', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  const items = [{ sku: 'a', quantity: 2, unit_price_minor: 1000 }, { sku: 'shipping', quantity: 1, unit_price_minor: 500 }]
  const ok = gate.decide(w.input(w.request({ items, amount_minor: 2500 }), grant))
  assert.equal(ok.verdict, 'permit')
  assert.equal(ok.record.evidence.policy_input.items_priced, true)
  const r = expectRefusal(w, gate, w.input(w.request({ items, amount_minor: 2600 }), grant), 'items_amount_mismatch')
  assert.match(r.record.evidence.decision_context.reasons[0], /sum to 2500 minor units, amount_minor is 2600/)
  expectRefusal(w, gate, w.input(w.request({ items, amount_minor: 2499 }), grant), 'items_amount_mismatch')
})

test('9. unpriced line items are accepted, and the evidence records that the amount was not cross-checked', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const r = gate.decide(w.input(w.request({ items: [{ sku: 'a', quantity: 3 }], amount_minor: 4321 }), grant))
  assert.equal(r.verdict, 'permit')
  assert.equal(r.record.evidence.policy_input.items_priced, false)
  assert.equal(w.verifies(r.record).valid, true)
})

test('9. items that mix priced and unpriced entries are malformed', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  const items = [{ sku: 'a', quantity: 1, unit_price_minor: 1000 }, { sku: 'b', quantity: 1 }]
  expectRefusal(w, gate, w.input(w.request({ items, amount_minor: 1000 }), grant), 'malformed_request')
})

test('9. a stale intent is refused, one inside the window is not', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  const ok = gate.decide(w.input(w.request(), grant, w.agent, undefined, new Date(w.clock.t - 299_000)))
  assert.equal(ok.verdict, 'permit')
  expectRefusal(w, gate, w.input(w.request(), grant, w.agent, undefined, new Date(w.clock.t - 300_001)), 'intent_stale')
})

test('9. an intent from the future is refused beyond the skew, accepted inside it', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  const ok = gate.decide(w.input(w.request(), grant, w.agent, undefined, new Date(w.clock.t + 29_000)))
  assert.equal(ok.verdict, 'permit')
  expectRefusal(w, gate, w.input(w.request(), grant, w.agent, undefined, new Date(w.clock.t + 31_000)), 'intent_from_future')
})

test('9. the freshness window is configurable', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open({ intentMaxAgeMs: 1000, intentMaxSkewMs: 0 })
  const grant = w.grant()
  control(w, gate, grant)
  expectRefusal(w, gate, w.input(w.request(), grant, w.agent, undefined, new Date(w.clock.t - 2000)), 'intent_stale')
  expectRefusal(w, gate, w.input(w.request(), grant, w.agent, undefined, new Date(w.clock.t + 1)), 'intent_from_future')
})

test('9. a permitted request replays its permit even after its intent has gone stale', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  const input = w.input(w.request(), grant)
  const first = gate.decide(input)
  assert.equal(first.verdict, 'permit')
  w.clock.t += 10 * 60_000
  const again = gate.decide(input)
  assert.equal(again.replay, true)
  assert.deepEqual(again.record, first.record)
})
