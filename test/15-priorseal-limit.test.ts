import assert from 'node:assert/strict'
import { test } from 'node:test'
import { purchaseGrant } from '../src/delegation.ts'
import { storeOrderCapCheck, type StoreOrderCap } from '../src/priorseal-limit.ts'
import { requestDigest } from '../src/request.ts'
import { expectRefusal, world } from './helpers.ts'

const cap: StoreOrderCap = {
  cap_id: 'store-checkout-v1',
  merchant_id: 'merchant-a',
  currency: 'USD',
  max_amount_minor: 500,
}

function setup(t: { after(fn: () => void): void }) {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open({ evidenceChecks: [storeOrderCapCheck(cap)] })
  const grant = w.grant()
  return { w, gate, grant, evidence: { store_order_cap: { ...cap } } }
}

test('15. the configured per-order cap allows amounts below and exactly at the ceiling', t => {
  const { w, gate, grant, evidence } = setup(t)
  const below = gate.decide({ ...w.input(w.request({ amount_minor: 499 }), grant), evidence })
  const at = gate.decide({ ...w.input(w.request({ amount_minor: 500 }), grant), evidence })
  assert.equal(below.verdict, 'permit', below.record.evidence.decision_context.reasons.join(' | '))
  assert.equal(at.verdict, 'permit', at.record.evidence.decision_context.reasons.join(' | '))
  const [belowEvidence, atEvidence] = [below, at].map(r => r.record.evidence.policy_input.required_evidence)
  assert.equal(belowEvidence?.[0]?.check, 'store_order_cap')
  assert.match(belowEvidence?.[0]?.evidence_id ?? '', /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(belowEvidence?.[0]?.evidence_id, atEvidence?.[0]?.evidence_id, 'the evidence id binds the exact request action_ref')

  const check = storeOrderCapCheck(cap)
  const original = w.request({ request_id: 'same-order', amount_minor: 499 })
  const changed = { ...original, amount_minor: 500, items: [{ ...original.items[0]!, unit_price_minor: 500 }] }
  const runCheck = (request: typeof original) => check.check({
    request,
    evidence: { ...cap },
    action_ref: requestDigest(request),
    agent_id: request.agent_id,
    now: new Date(w.clock.t),
  })
  assert.notEqual(runCheck(original).evidence_id, runCheck(changed).evidence_id, 'changing amount changes the action_ref and evidence id')
})

test('15. evidence id commits to the whole current cap, and stale cap snapshots are refused', t => {
  const w = world(); t.after(() => w.cleanup())
  const request = w.request({ request_id: 'same-order', amount_minor: 300 })
  const actionRef = requestDigest(request)
  const tightenedCap: StoreOrderCap = { ...cap, max_amount_minor: 400 }
  const current = storeOrderCapCheck(cap).check({
    request,
    evidence: { ...cap },
    action_ref: actionRef,
    agent_id: request.agent_id,
    now: new Date(w.clock.t),
  })
  const tightened = storeOrderCapCheck(tightenedCap).check({
    request,
    evidence: { ...tightenedCap },
    action_ref: actionRef,
    agent_id: request.agent_id,
    now: new Date(w.clock.t),
  })
  assert.deepEqual(current.problems, [])
  assert.deepEqual(tightened.problems, [])
  assert.notEqual(current.evidence_id, tightened.evidence_id, 'the same request under a changed cap must have a different evidence id')

  const gate = w.open({ evidenceChecks: [storeOrderCapCheck(tightenedCap)] })
  const grant = w.grant()
  const refusal = expectRefusal(w, gate, {
    ...w.input(request, grant),
    evidence: { store_order_cap: { ...cap } },
  }, 'store_cap_snapshot_invalid')
  assert.equal(refusal.record.evidence.policy_input.required_evidence?.[0]?.evidence_id, null)
  assert.equal(gate.reservationForRequest(request.request_id), undefined)
})

test('15. an amount above the configured cap is refused before reservation', t => {
  const { w, gate, grant, evidence } = setup(t)
  const request = w.request({ amount_minor: 501 })
  const r = expectRefusal(w, gate, { ...w.input(request, grant), evidence }, 'store_order_cap_exceeded')
  assert.equal(r.record.evidence.policy_input.required_evidence?.[0]?.check, 'store_order_cap')
})

test('15. merchant and currency must match the configured cap', t => {
  {
    const w = world(); t.after(() => w.cleanup())
    const gate = w.open({ evidenceChecks: [storeOrderCapCheck(cap)] })
    const grant = w.grant({ grants: [purchaseGrant('merchant-b')] })
    const request = w.request({ merchant_id: 'merchant-b', amount_minor: 100 })
    expectRefusal(w, gate, { ...w.input(request, grant), evidence: { store_order_cap: { ...cap } } }, 'store_cap_merchant_mismatch')
  }
  {
    const w = world(); t.after(() => w.cleanup())
    const gate = w.open({ evidenceChecks: [storeOrderCapCheck(cap)] })
    const grant = w.grant({ currency: 'EUR' })
    const request = w.request({ currency: 'EUR', amount_minor: 100 })
    expectRefusal(w, gate, { ...w.input(request, grant), evidence: { store_order_cap: { ...cap } } }, 'store_cap_currency_mismatch')
  }
})

test('15. caller-provided evidence cannot raise or replace the configured cap', t => {
  const { w, gate, grant } = setup(t)
  const request = w.request({ amount_minor: 501 })
  const evidence = { store_order_cap: { ...cap, max_amount_minor: 10_000 } }
  expectRefusal(w, gate, { ...w.input(request, grant), evidence }, 'store_cap_snapshot_invalid')
  assert.equal(gate.reservationForRequest(request.request_id), undefined)
})

test('15. invalid store cap configuration fails when the adapter is built', () => {
  for (const invalid of [
    { ...cap, merchant_id: 'merchant:other' },
    { ...cap, currency: 'usd' },
    { ...cap, max_amount_minor: 0 },
    { ...cap, max_amount_minor: 1.5 },
    { ...cap, max_amount_minor: Number.MAX_SAFE_INTEGER + 1 },
    { ...cap, extra: true },
  ]) {
    assert.throws(() => storeOrderCapCheck(invalid as never), JSON.stringify(invalid))
  }
})
