// Optional settlement receipt on 'placed' (src/settlement.ts), driven by real invinoveritas /payment-receipt events.
//
// test/vectors/invinoveritas-payment-receipt-2afb35e2.json: three receipts the issuer signed for ONE real payment
// (Base mainnet USDC 1.00, tx 0x2afb35e2...). bound_1 and bound_2 were requested with terms_hash = the action_ref of
// two synthetic $1.00 orders; unbound has no terms_hash. The orders, keys and grants are synthetic; the payment and
// the issuer signatures are real.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { issueGrant, purchaseGrant } from '../src/delegation.ts'
import { Gate } from '../src/gate.ts'
import type { GateConfig } from '../src/gate.ts'
import { makeParty, trustedKeys } from '../src/parties.ts'
import { requestDigest, signIntent } from '../src/request.ts'
import type { PurchaseRequest } from '../src/request.ts'
import { settlementProblems, validateSettlementRequirement } from '../src/settlement.ts'
import type { SettlementRequirement } from '../src/settlement.ts'
import { eventId } from '../src/verdict.ts'
import type { NostrEvent } from '../src/verdict.ts'

interface Vector {
  requests: PurchaseRequest[]; action_refs: string[]; issuer_pubkey: string; network: string; asset: string; payee: string; payer: string
  bound_1: NostrEvent; bound_2: NostrEvent; unbound: NostrEvent
}
const V: Vector = JSON.parse(readFileSync(new URL('./vectors/invinoveritas-payment-receipt-2afb35e2.json', import.meta.url), 'utf8'))
const REQ: SettlementRequirement = { issuerPubkey: V.issuer_pubkey, network: V.network, asset: V.asset, payee: V.payee, unit: 'USD', atomicPerMinor: 10_000 }

function setup(t: { after(fn: () => void): void }, extra: Partial<GateConfig> = {}, currency = 'USD') {
  const dir = mkdtempSync(join(tmpdir(), 'aps-checkout-gate-settle-'))
  const at = new Date('2026-10-16T02:00:00Z')
  const gateParty = makeParty('did:example:gate', 'gate')
  const principal = makeParty('did:example:buyer', 'principal')
  const shopper = makeParty(V.requests[0].agent_id, 'agent')
  const gate = Gate.open({ dbPath: join(dir, 'gate.db'), gate: gateParty, directory: trustedKeys([gateParty, principal, shopper]), now: () => at, ...extra })
  t.after(() => { try { gate.close() } catch { /* closed already */ } rmSync(dir, { recursive: true, force: true }) })
  const grant = issueGrant(principal, shopper, { grants: [purchaseGrant('example-store')], currency, per_action_minor: 10_000, cumulative_minor: 10_000, issued_at: at })
  const permit = (req: PurchaseRequest) => {
    const r = gate.decide({ request: { ...req, currency }, delegation: grant, intent: signIntent({ ...req, currency }, shopper, grant, at) })
    assert.equal(r.verdict, 'permit', r.reason)
    return r.reservation_id as string
  }
  return { gate, permit }
}
const conf = (ev?: unknown) => (ev === undefined ? { platform_ref: 'order-1' } : { platform_ref: 'order-1', payment_receipt: ev })

test('17. the vectors: action_refs recompute, each receipt verifies and binds its order, all three are one settlement', () => {
  V.requests.forEach((r, i) => assert.equal(requestDigest(r), V.action_refs[i]))
  for (const [ev, ref] of [[V.bound_1, V.action_refs[0]], [V.bound_2, V.action_refs[1]]] as const) {
    assert.equal(eventId(ev), ev.id)
    assert.deepEqual(settlementProblems(ev, { action_ref: ref, agent_id: V.requests[0].agent_id, amount_minor: 100 }, validateSettlementRequirement(REQ)), [])
  }
  const sid = (e: NostrEvent) => JSON.parse(e.content).settlement_id
  assert.equal(sid(V.bound_1), sid(V.bound_2))
  assert.equal(sid(V.bound_1), sid(V.unbound))
})

test("17. off by default: 'placed' commits without a receipt", t => {
  const { gate, permit } = setup(t)
  assert.equal(gate.reportOutcome(permit(V.requests[0]), 'placed').code, 'recorded')
})

test("17. with the requirement, the real bound receipt commits 'placed' and the settlement is recorded", t => {
  const { gate, permit } = setup(t, { settlementReceipt: REQ })
  const id = permit(V.requests[0])
  const r = gate.reportOutcome(id, 'placed', conf(V.bound_1))
  assert.deepEqual(r, { ok: true, code: 'recorded', state: 'committed' })
  const row = gate.db.prepare('SELECT settlement_id, reservation_id, receipt_event_id FROM settlements').all() as Record<string, string>[]
  assert.deepEqual(row.map(x => ({ ...x })), [{ settlement_id: JSON.parse(V.bound_1.content).settlement_id.toLowerCase(), reservation_id: id, receipt_event_id: V.bound_1.id }])
})

test('17. one payment, one order: the same settlement re-bound to a second order is refused', t => {
  const { gate, permit } = setup(t, { settlementReceipt: REQ })
  assert.equal(gate.reportOutcome(permit(V.requests[0]), 'placed', conf(V.bound_1)).code, 'recorded')
  const second = permit(V.requests[1])
  assert.deepEqual(gate.reportOutcome(second, 'placed', conf(V.bound_2)), { ok: false, code: 'receipt_settlement_reused', state: 'reserved' })
  assert.equal(gate.reservation(second)?.state, 'reserved')
})

test('17. refusals leave the reservation reserved', t => {
  const { gate, permit } = setup(t, { settlementReceipt: REQ })
  const id = permit(V.requests[0])
  const tampered = { ...V.bound_1, content: V.bound_1.content.replace('"observed_amount":"1000000"', '"observed_amount":"2000000"') }
  const cases: [unknown, string][] = [
    [undefined, 'receipt_missing'],
    [V.unbound, 'receipt_not_bound'],
    [V.bound_2, 'receipt_not_bound'],
    [tampered, 'receipt_invalid'],
    [{ ...V.bound_1, sig: '00'.repeat(64) }, 'receipt_invalid'],
    ['not an event', 'receipt_invalid'],
  ]
  for (const [ev, code] of cases) assert.deepEqual(gate.reportOutcome(id, 'placed', conf(ev)), { ok: false, code, state: 'reserved' }, code)
  assert.equal(gate.reservation(id)?.state, 'reserved')
})

test('17. the store configuration decides issuer, payee, amount and payer', () => {
  const ctx = { action_ref: V.action_refs[0], agent_id: V.requests[0].agent_id, amount_minor: 100 }
  const codes = (cfg: Partial<SettlementRequirement>, c = ctx) => settlementProblems(V.bound_1, c, validateSettlementRequirement({ ...REQ, ...cfg })).map(p => p.code)
  assert.deepEqual(codes({ issuerPubkey: 'ab'.repeat(32) }), ['receipt_untrusted_key'])
  assert.deepEqual(codes({ payee: '0x' + '11'.repeat(20) }), ['receipt_payee_mismatch'])
  assert.deepEqual(codes({ atomicPerMinor: 20_000 }), ['receipt_amount_mismatch'])
  assert.deepEqual(codes({}, { ...ctx, amount_minor: 101 }), ['receipt_amount_mismatch'])
  assert.deepEqual(codes({ asset: '0x' + '22'.repeat(20) }), ['receipt_asset_mismatch'])
  assert.deepEqual(codes({ network: 'eip155:84532' }), ['receipt_network_mismatch'])
  assert.deepEqual(codes({ payerFor: () => V.payer }), [])
  assert.deepEqual(codes({ payerFor: () => '0x' + '33'.repeat(20) }), ['receipt_payer_mismatch'])
  assert.deepEqual(codes({ payerFor: () => undefined }), ['receipt_payer_mismatch'])
})

test('17. reconcile placed needs the receipt too; failed outcomes and other units are unchanged', t => {
  const { gate, permit } = setup(t, { settlementReceipt: REQ })
  const id = permit(V.requests[0])
  assert.equal(gate.reportOutcome(id, 'unknown').state, 'unresolved')
  assert.equal(gate.reconcile(id, { outcome: 'placed', confirmation: conf() }).code, 'receipt_missing')
  assert.deepEqual(gate.reconcile(id, { outcome: 'placed', confirmation: conf(V.bound_1) }), { ok: true, code: 'reconciled', state: 'committed' })
  const failed = permit(V.requests[1])
  assert.equal(gate.reportOutcome(failed, 'failed', conf()).state, 'released')
})

test('17. a reservation in another unit commits without a receipt', t => {
  const { gate, permit } = setup(t, { settlementReceipt: REQ }, 'EUR')
  assert.equal(gate.reportOutcome(permit(V.requests[0]), 'placed').code, 'recorded')
})

test('17. a malformed requirement fails when the gate opens', t => {
  for (const bad of [{ ...REQ, issuerPubkey: 'x' }, { ...REQ, payee: 'store' }, { ...REQ, atomicPerMinor: 0 }, { ...REQ, unit: 'usd' }, { ...REQ, network: 'base' }]) {
    assert.throws(() => setup(t, { settlementReceipt: bad as SettlementRequirement }))
  }
})
