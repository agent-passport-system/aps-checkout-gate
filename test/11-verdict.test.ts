// Optional required evidence: an independent signed verdict on the exact request (src/verdict.ts).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { requestDigest } from '../src/request.ts'
import type { PurchaseRequest } from '../src/request.ts'
import { eventId, secp256k1ForTests as C, verdictCheck, verdictProblems } from '../src/verdict.ts'
import type { NostrEvent } from '../src/verdict.ts'
import { control, expectRefusal, world } from './helpers.ts'

// A deterministic BIP-340 signer for these tests only (aux = 32 zero bytes).
const hex32 = (n: bigint) => Buffer.from(n.toString(16).padStart(64, '0'), 'hex')
function keypair(label: string) {
  const d0 = C.toBig(C.taggedHash('test/seed', Buffer.from(label))) % C.N
  const P = C.mul(C.G, d0)!
  return { d0, P, pub: hex32(P[0]).toString('hex') }
}
function sign(msg: Buffer, k: ReturnType<typeof keypair>): string {
  const d = k.P[1] % 2n === 0n ? k.d0 : C.N - k.d0
  const t = Buffer.from(hex32(d).map((b, i) => b ^ C.taggedHash('BIP0340/aux', Buffer.alloc(32))[i]))
  const k0 = C.toBig(C.taggedHash('BIP0340/nonce', Buffer.concat([t, hex32(k.P[0]), msg]))) % C.N
  const R = C.mul(C.G, k0)!
  const kk = R[1] % 2n === 0n ? k0 : C.N - k0
  const e = C.toBig(C.taggedHash('BIP0340/challenge', Buffer.concat([hex32(R[0]), hex32(k.P[0]), msg]))) % C.N
  return Buffer.concat([hex32(R[0]), hex32((kk + e * d) % C.N)]).toString('hex')
}
const REVIEWER = keypair('reviewer')
const OTHER = keypair('someone-else')

function verdictFor(req: PurchaseRequest, at: number, over: Record<string, unknown> = {}, key = REVIEWER): NostrEvent {
  const content = JSON.stringify({
    verdict: 'approve', verified_at: Math.floor(at / 1000),
    action_binding_args_hash: 'sha256:' + requestDigest(req), action_binding_agent_id: req.agent_id, ...over,
  })
  const ev = { pubkey: key.pub, created_at: Math.floor(at / 1000), kind: 30078, tags: [], content, id: '', sig: '' }
  ev.id = eventId(ev)
  ev.sig = sign(Buffer.from(ev.id, 'hex'), key)
  return ev
}

function setup(t: { after(fn: () => void): void }, proceedOn?: string[]) {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open({ evidenceChecks: [verdictCheck({ verifierPubkey: REVIEWER.pub, ...(proceedOn ? { proceedOn } : {}) })] })
  const grant = w.grant()
  return { w, gate, grant }
}

test('11. without evidence checks the gate ignores evidence entirely', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  control(w, gate, grant)
  const r = gate.decide(w.input(w.request(), grant))
  assert.equal(r.verdict, 'permit')
  assert.equal('required_evidence' in r.record.evidence.policy_input, false, 'records are unchanged when no check is configured')
})

test('11. a valid verdict on this exact request permits, and the permit cites it', t => {
  const { w, gate, grant } = setup(t)
  const req = w.request()
  const ev = verdictFor(req, w.clock.t)
  const r = gate.decide({ ...w.input(req, grant), evidence: { verdict: ev } })
  assert.equal(r.verdict, 'permit', r.record.evidence.decision_context.reasons.join(' | '))
  assert.deepEqual(r.record.evidence.policy_input.required_evidence, [{ check: 'verdict', evidence_id: ev.id }])
  assert.deepEqual(w.verifies(r.record), { valid: true, problems: [] })
})

test('11. no verdict is refused', t => {
  const { w, gate, grant } = setup(t)
  expectRefusal(w, gate, w.input(w.request(), grant), 'evidence_missing')
})

test('11. a verdict on a different request is refused', t => {
  const { w, gate, grant } = setup(t)
  const req = w.request()
  const ev = verdictFor(w.request({ order_ref: 'some-other-order' }), w.clock.t)
  expectRefusal(w, gate, { ...w.input(req, grant), evidence: { verdict: ev } }, 'verdict_request_mismatch')
})

test('11. a verdict naming another agent is refused', t => {
  const { w, gate, grant } = setup(t)
  const req = w.request()
  expectRefusal(w, gate, { ...w.input(req, grant), evidence: { verdict: verdictFor(req, w.clock.t, { action_binding_agent_id: 'did:example:someone' }) } }, 'verdict_agent_mismatch')
})

test('11. reject is refused; approve_with_concerns only when the store allows it', t => {
  const { w, gate, grant } = setup(t)
  const req = w.request()
  expectRefusal(w, gate, { ...w.input(req, grant), evidence: { verdict: verdictFor(req, w.clock.t, { verdict: 'reject' }) } }, 'verdict_not_allowed')
  const req2 = w.request()
  expectRefusal(w, gate, { ...w.input(req2, grant), evidence: { verdict: verdictFor(req2, w.clock.t, { verdict: 'approve_with_concerns' }) } }, 'verdict_not_allowed')
  const lax = setup(t, ['approve', 'approve_with_concerns'])
  const req3 = lax.w.request()
  const r = lax.gate.decide({ ...lax.w.input(req3, lax.grant), evidence: { verdict: verdictFor(req3, lax.w.clock.t, { verdict: 'approve_with_concerns' }) } })
  assert.equal(r.verdict, 'permit')
})

test('11. a stale verdict and a verdict from the future are refused', t => {
  const { w, gate, grant } = setup(t)
  const req = w.request()
  expectRefusal(w, gate, { ...w.input(req, grant), evidence: { verdict: verdictFor(req, w.clock.t - 11 * 60_000) } }, 'verdict_stale')
  const req2 = w.request()
  expectRefusal(w, gate, { ...w.input(req2, grant), evidence: { verdict: verdictFor(req2, w.clock.t + 5 * 60_000) } }, 'verdict_from_future')
})

test('11. a bad signature, edited content and an untrusted key are refused', t => {
  const { w, gate, grant } = setup(t)
  const req = w.request()
  const ev = verdictFor(req, w.clock.t)
  const badSig = { ...ev, sig: ev.sig.slice(0, 10) + (ev.sig[10] === '0' ? '1' : '0') + ev.sig.slice(11) }
  expectRefusal(w, gate, { ...w.input(req, grant), evidence: { verdict: badSig } }, 'verdict_invalid')
  const edited = { ...ev, content: ev.content.replace('"approve"', '"approve" ') }
  expectRefusal(w, gate, { ...w.input(w.request(), grant), evidence: { verdict: edited } }, 'verdict_invalid')
  const req3 = w.request()
  expectRefusal(w, gate, { ...w.input(req3, grant), evidence: { verdict: verdictFor(req3, w.clock.t, {}, OTHER) } }, 'verdict_untrusted_key')
})

test('11. a real invinoveritas /review verdict binds a request the same way (live vector, 2026-10-12)', () => {
  const v = JSON.parse(readFileSync(new URL('./vectors/invinoveritas-verdict-b2cd036a.json', import.meta.url), 'utf8'))
  assert.equal(requestDigest(v.request), v.action_ref)
  const at = new Date(JSON.parse(v.event.content).verified_at * 1000 + 1000)
  assert.deepEqual(verdictProblems(v.event, v.request, v.action_ref, at,
    { verifierPubkey: v.event.pubkey, proceedOn: ['approve', 'approve_with_concerns'] }), [])
  assert.deepEqual(verdictProblems(v.event, v.request, v.action_ref, at, { verifierPubkey: v.event.pubkey }).map(p => p.code), ['verdict_not_allowed'])
})
