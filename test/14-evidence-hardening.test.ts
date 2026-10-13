// Regressions for the four defects found in review of 12f5023 (boot-reviews 2026-10-13). Each test uses the
// reproduced input: evidence aliasing the request, a __proto__ check name, malformed check results, and malformed
// verdict configuration.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { EvidenceCheck } from '../src/evidence.ts'
import { verdictCheck, verdictProblems } from '../src/verdict.ts'
import { expectRefusal, world } from './helpers.ts'

test('14. evidence that references the request cannot change what is authorized or reserved', t => {
  const w = world(); t.after(() => w.cleanup())
  const mutate: EvidenceCheck = {
    name: 'x',
    check(i) {
      const ev = i.evidence as Record<string, unknown>
      ev.amount_minor = 1
      ;(i.request as unknown as Record<string, unknown>).amount_minor = 2
      return { problems: [], evidence_id: null }
    },
  }
  const gate = w.open({ evidenceChecks: [mutate] })
  const grant = w.grant()
  const req = w.request({ amount_minor: 3000 })
  // The evidence is the request object itself, and a second key aliases the delegation.
  const r = gate.decide({ ...w.input(req, grant), evidence: { x: req } })
  assert.equal(r.verdict, 'permit')
  assert.equal(gate.reservation(r.reservation_id!)!.amount_minor, 3000, 'the reservation is the authorized amount')
  assert.equal(req.amount_minor, 3000, 'the caller object is untouched')
  assert.deepEqual(w.verifies(r.record), { valid: true, problems: [] })

  const g2 = w.open({ evidenceChecks: [{ name: 'd', check(i) { (i.evidence as Record<string, unknown>).delegation_id = 'changed'; return { problems: [], evidence_id: null } } }] })
  const grant2 = w.grant()
  const r2 = g2.decide({ ...w.input(w.request({ amount_minor: 100 }), grant2), evidence: { d: grant2 } })
  assert.equal(r2.verdict, 'permit')
  assert.equal(r2.record.evidence.authority_state.grant_id, grant2.delegation_id)
  assert.equal(grant2.delegation_id.startsWith('sha256:'), true)
})

test('14. a check name that resolves through Object.prototype is refused at configuration', t => {
  const w = world(); t.after(() => w.cleanup())
  const pass = (name: string): EvidenceCheck => ({ name, check: () => ({ problems: [], evidence_id: 'x' }) })
  for (const name of ['__proto__', 'constructor']) {
    assert.throws(() => w.open({ evidenceChecks: [pass(name)] }), /reserved/)
  }
  // Control: an ordinary name with no evidence supplied is refused as missing, and the check never runs.
  let calls = 0
  const gate = w.open({ evidenceChecks: [{ name: 'normal', check: () => { calls++; return { problems: [], evidence_id: 'x' } } }] })
  expectRefusal(w, gate, w.input(w.request(), w.grant()), 'evidence_missing')
  assert.equal(calls, 0)
})

test('14. a malformed check result is a signed refusal, never a throw', t => {
  const cases: [string, () => unknown][] = [
    ['throwing problems getter', () => ({ get problems() { throw new Error('result-getter') }, evidence_id: null })],
    ['throwing result proxy', () => new Proxy({}, { get() { throw new Error('result-proxy') } })],
    ['sparse problems', () => ({ problems: Array(1), evidence_id: null })],
    ['problem with a throwing code getter', () => ({ problems: [{ get code() { throw new Error('code') }, message: 'm' }], evidence_id: null })],
    ['thrown value that cannot be printed', () => { throw { toString() { throw new Error('no') } } }],
  ]
  for (const [label, make] of cases) {
    const w = world(); t.after(() => w.cleanup())
    const gate = w.open({ evidenceChecks: [{ name: 'x', check: make as EvidenceCheck['check'] }] })
    const grant = w.grant()
    const input = { ...w.input(w.request(), grant), evidence: { x: true } }
    const r = expectRefusal(w, gate, input, 'evidence_check_failed')
    assert.equal(gate.budget(grant.delegation_id).held, '0', label)
  }
})

test('14. malformed verdict configuration fails when the adapter is built', () => {
  const v = JSON.parse(readFileSync(new URL('./vectors/invinoveritas-verdict-b2cd036a.json', import.meta.url), 'utf8'))
  const base = { verifierPubkey: v.event.pubkey as string }
  for (const bad of [
    { maxAgeMs: '600000ms' }, { maxSkewMs: '30000ms' }, { maxAgeMs: -1 }, { maxAgeMs: Number.NaN }, { maxSkewMs: Infinity },
    { proceedOn: 'do_not_approve_with_concerns' }, { proceedOn: [] }, { proceedOn: ['approve', 7] },
  ]) {
    assert.throws(() => verdictCheck({ ...base, ...(bad as object) } as never), JSON.stringify(bad))
  }
  assert.throws(() => verdictCheck({ verifierPubkey: 'nothex' }))
  // Controls: valid numbers and arrays still work, and the exported verdictProblems refuses the same bad config.
  const issued = JSON.parse(v.event.content).verified_at * 1000
  assert.deepEqual(verdictProblems(v.event, v.request, v.action_ref, new Date(issued + 660_000), { ...base, proceedOn: ['approve', 'approve_with_concerns'], maxAgeMs: 600_000 }).map(p => p.code), ['verdict_stale'])
  assert.throws(() => verdictProblems(v.event, v.request, v.action_ref, new Date(issued), { ...base, maxAgeMs: '600000ms' } as never))
})
