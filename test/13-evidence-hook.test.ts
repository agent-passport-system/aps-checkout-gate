// The optional evidence hook (src/evidence.ts): any project's check plugs in without editing gate.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EvidenceCheck, EvidenceCheckInput } from '../src/evidence.ts'
import { requestDigest } from '../src/request.ts'
import { expectRefusal, world } from './helpers.ts'

const throwingProxy = () => new Proxy({}, { get() { throw new Error('read') }, ownKeys() { throw new Error('read') } })

function setup(t: { after(fn: () => void): void }, checks: EvidenceCheck[]) {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open({ evidenceChecks: checks })
  return { w, gate, grant: w.grant() }
}

const tokenCheck = (seen: EvidenceCheckInput[] = []): EvidenceCheck => ({
  name: 'token',
  check(i) {
    seen.push(i)
    return i.evidence === 'ok' ? { problems: [], evidence_id: 'tok-1' } : { problems: [{ code: 'token_wrong', message: 'wrong token' }], evidence_id: null }
  },
})

test('13. unused evidence cannot change the decision', t => {
  // No checks configured: evidence that cannot even be read is ignored.
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant()
  for (const evidence of [throwingProxy(), { verdict: () => 1 }, { verdict: throwingProxy() }]) {
    const r = gate.decide({ ...w.input(w.request(), grant), evidence: evidence as never })
    assert.equal(r.verdict, 'permit', r.record.evidence.decision_context.reasons.join(' | '))
    assert.equal('required_evidence' in r.record.evidence.policy_input, false)
  }
  // A check configured: evidence under any other name is never read either.
  const s = setup(t, [tokenCheck()])
  const r = s.gate.decide({ ...s.w.input(s.w.request(), s.grant), evidence: { token: 'ok', verdict: () => 1, other: throwingProxy() } })
  assert.equal(r.verdict, 'permit', r.record.evidence.decision_context.reasons.join(' | '))
})

test('13. a check gets the request, its evidence, action_ref, agent and the gate clock; its id is recorded', t => {
  const seen: EvidenceCheckInput[] = []
  const { w, gate, grant } = setup(t, [tokenCheck(seen)])
  const req = w.request()
  const r = gate.decide({ ...w.input(req, grant), evidence: { token: 'ok' } })
  assert.equal(r.verdict, 'permit', r.record.evidence.decision_context.reasons.join(' | '))
  assert.deepEqual(r.record.evidence.policy_input.required_evidence, [{ check: 'token', evidence_id: 'tok-1' }])
  assert.equal(seen.length, 1)
  assert.deepEqual(seen[0].request, req)
  assert.equal(seen[0].evidence, 'ok')
  assert.equal(seen[0].action_ref, requestDigest(req))
  assert.equal(seen[0].agent_id, req.agent_id)
  assert.equal(seen[0].now.getTime(), w.clock.t)
})

test('13. a check that refuses, throws or returns a malformed result refuses before any reservation', t => {
  const { w, gate, grant } = setup(t, [tokenCheck()])
  const ok = gate.decide({ ...w.input(w.request({ amount_minor: 100 }), grant), evidence: { token: 'ok' } })
  assert.equal(ok.verdict, 'permit', 'control: the same gate permits with good evidence')
  expectRefusal(w, gate, { ...w.input(w.request(), grant), evidence: { token: 'nope' } }, 'token_wrong')
  const bad: [string, () => unknown][] = [
    ['throws', () => { throw new Error('boom') }],
    ['null', () => null],
    ['problems not an array', () => ({ problems: 'x', evidence_id: null })],
    ['problem without a string code', () => ({ problems: [{ code: 1, message: 'm' }], evidence_id: null })],
    ['no evidence_id', () => ({ problems: [] })],
  ]
  for (const [label, check] of bad) {
    const s = setup(t, [{ name: 'x', check: check as never }])
    const r = expectRefusal(s.w, s.gate, { ...s.w.input(s.w.request(), s.grant), evidence: { x: 1 } }, 'evidence_check_failed')
    assert.deepEqual(r.record.evidence.policy_input.required_evidence, [{ check: 'x', evidence_id: null }], label)
  }
})

test('13. missing evidence is refused, including a name only on the prototype', t => {
  const { w, gate, grant } = setup(t, [tokenCheck()])
  expectRefusal(w, gate, w.input(w.request(), grant), 'evidence_missing')
  expectRefusal(w, gate, { ...w.input(w.request(), grant), evidence: Object.create({ token: 'ok' }) }, 'evidence_missing')
})

test('13. every check must pass, and every refusal is listed', t => {
  const second: EvidenceCheck = { name: 'second', check: () => ({ problems: [{ code: 'second_no', message: 'no' }], evidence_id: 's' }) }
  const { w, gate, grant } = setup(t, [tokenCheck(), second])
  const r = expectRefusal(w, gate, { ...w.input(w.request(), grant), evidence: { token: 'nope', second: 1 } }, 'token_wrong')
  assert.ok(r.record.evidence.decision_context.reasons.some(x => x.startsWith('second_no')), r.record.evidence.decision_context.reasons.join(' | '))
})

test('13. a check cannot change the request the gate decides on', t => {
  const mutating: EvidenceCheck = { name: 'm', check(i) { (i.request as { amount_minor: number }).amount_minor = 1; return { problems: [], evidence_id: null } } }
  const { w, gate, grant } = setup(t, [mutating])
  const req = w.request()
  const r = gate.decide({ ...w.input(req, grant), evidence: { m: true } })
  assert.equal(r.verdict, 'permit', r.record.evidence.decision_context.reasons.join(' | '))
  assert.equal(gate.reservation(r.reservation_id!)!.amount_minor, req.amount_minor)
})

test('13. the gate does not open with a malformed or duplicated check', t => {
  const w = world(); t.after(() => w.cleanup())
  assert.throws(() => w.open({ evidenceChecks: [{ name: 'Bad Name', check: () => ({ problems: [], evidence_id: null }) }] }))
  assert.throws(() => w.open({ evidenceChecks: [tokenCheck(), tokenCheck()] }))
})
