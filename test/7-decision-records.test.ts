import assert from 'node:assert/strict'
import { test } from 'node:test'
import { canonicalizeJCS, sign } from 'agent-passport-system'
import { verifyDecision } from '../src/decision.ts'
import type { DecisionRecord } from '../src/decision.ts'
import { makeParty } from '../src/parties.ts'
import { world } from './helpers.ts'

test('7. permit and refusal records verify with the gate public key, tampered records fail', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 5000 })
  const permit = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant)).record
  const refusal = gate.decide(w.input(w.request({ amount_minor: 1 }), grant)).record
  assert.equal(permit.verdict, 'permit')
  assert.equal(refusal.reason, 'budget_exceeded')
  assert.equal(permit.gate_key_id, 'did:example:gate#key-1')

  for (const rec of [permit, refusal]) {
    assert.deepEqual(verifyDecision(rec, w.gateParty.publicKey), { valid: true, problems: [] })
    // The stored copy round-trips through JSON and still verifies.
    assert.equal(verifyDecision(JSON.parse(JSON.stringify(gate.decision(rec.decision_id))), w.gateParty.publicKey).valid, true)
    // A different key does not verify it.
    assert.equal(verifyDecision(rec, makeParty('did:example:other', 'gate').publicKey).valid, false)
  }

  const tampered: [string, (r: DecisionRecord) => void][] = [
    ['verdict flipped to permit', r => { r.verdict = 'permit'; r.reason = 'permitted'; r.reservation_id = 'res_forged' }],
    ['reason changed', r => { r.reason = 'grant_revoked' }],
    ['request digest changed', r => { r.request_digest = '0'.repeat(64) }],
    ['grant id changed', r => { r.grant_id = 'some-other-grant' }],
    ['time changed', r => { r.decided_at = '2030-01-01T00:00:00.000Z' }],
    ['extra unsigned field', r => { (r as unknown as Record<string, unknown>).final = 'permit' }],
    ['signature truncated', r => { r.signature = r.signature.slice(0, 64) }],
  ]
  for (const [name, edit] of tampered) {
    const r = structuredClone(refusal)
    edit(r)
    assert.equal(verifyDecision(r, w.gateParty.publicKey).valid, false, `tampered (${name}) still verified`)
  }
  const p = structuredClone(permit)
  p.reservation_id = 'res_other'
  assert.equal(verifyDecision(p, w.gateParty.publicKey).valid, false, 'permit with a swapped reservation still verified')

  // Re-signed by someone else over the edited body: still fails under the gate key.
  const { signature: _s, ...body } = structuredClone(refusal)
  const forged = { ...body, verdict: 'permit' as const, reason: 'permitted', reservation_id: 'res_x' }
  const outsider = makeParty('did:example:outsider', 'gate')
  const reSigned = { ...forged, signature: sign(canonicalizeJCS(forged), outsider.privateKey) }
  assert.equal(verifyDecision(reSigned, w.gateParty.publicKey).valid, false)
  assert.equal(verifyDecision(reSigned, outsider.publicKey).valid, true, 'control: it verifies only under the outsider key')
})
