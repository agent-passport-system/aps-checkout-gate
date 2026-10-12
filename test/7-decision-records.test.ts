import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyReceiptV1 } from 'agent-passport-system'
import { issueDecision, verifyDecision } from '../src/decision.ts'
import type { DecisionRecord } from '../src/decision.ts'
import { makeParty } from '../src/parties.ts'
import { world } from './helpers.ts'

test('7. permit and deny receipts verify with the gate key, tampered receipts and evidence fail', t => {
  const w = world(); t.after(() => w.cleanup())
  const gate = w.open()
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: 5000 })
  const permit = gate.decide(w.input(w.request({ amount_minor: 5000 }), grant)).record
  const deny = gate.decide(w.input(w.request({ amount_minor: 1 }), grant)).record
  assert.equal(permit.receipt.result.verdict, 'permit')
  assert.equal(deny.evidence.decision_context.reason, 'budget_exceeded')
  assert.equal(permit.receipt.signatures[0].key_id, 'did:example:gate#key-1')
  const gateKey = (s: string) => (s === w.gateParty.id ? w.gateParty.publicKey : undefined)

  for (const rec of [permit, deny]) {
    // The SDK verifier on the receipt alone.
    const rv = verifyReceiptV1(rec.receipt, gateKey, { boundaryIdentity: w.gateParty.id })
    assert.equal(rv.valid, true, rv.errors.join(' | '))
    // The receipt with its decision evidence.
    assert.deepEqual(w.verifies(rec), { valid: true, problems: [] })
    // The stored copy round-trips through JSON and still verifies.
    assert.equal(w.verifies(JSON.parse(JSON.stringify(gate.decision(rec.receipt.receipt_id)))).valid, true)
    // A different key, or a different expected gate identity, does not verify it.
    assert.equal(verifyDecision(rec, w.gateParty.id, makeParty('did:example:other', 'gate').publicKey).valid, false)
    assert.equal(verifyDecision(rec, 'did:example:other-gate', w.gateParty.publicKey).valid, false)
  }

  const tampered: [string, (r: DecisionRecord) => void][] = [
    ['verdict flipped to permit in the receipt', r => {
      r.receipt.result = { ...r.receipt.result, verdict: 'permit', effective_authority_ref: 'a'.repeat(64), valid_until: '2099-01-01T00:00:00.000Z' }
    }],
    ['verdict flipped in receipt and evidence alike', r => {
      const out = { profile: 'aps-core-decision-output-v1' as const, verdict: 'permit' as const, effective_authority_ref: 'a'.repeat(64), constraints: [], valid_until: '2099-01-01T00:00:00.000Z' }
      r.receipt.result = out
      r.evidence.decision_output = out
      r.evidence.decision_context.reason = 'permitted'
      r.evidence.decision_context.reservation_id = 'res_forged'
    }],
    ['action_ref changed', r => { r.receipt.action_ref = '0'.repeat(64) }],
    ['prev changed', r => { r.receipt.prev = '1'.repeat(64) }],
    ['reason changed in the evidence', r => { r.evidence.decision_context.reason = 'grant_revoked' }],
    ['reasons edited in the evidence', r => { r.evidence.decision_context.reasons = [] }],
    ['request digest changed in the evidence', r => { r.evidence.policy_input.request_digest = '0'.repeat(64) }],
    ['grant id changed in the evidence', r => { r.evidence.authority_state.grant_id = 'some-other-grant' }],
    ['issued_at changed', r => { r.receipt.issued_at = '2030-01-01T00:00:00.000Z' }],
    ['extra unsigned field on the receipt', r => { (r.receipt as unknown as Record<string, unknown>).final = 'permit' }],
    ['extra field next to receipt and evidence', r => { (r as unknown as Record<string, unknown>).final = 'permit' }],
    ['signature truncated', r => { r.receipt.signatures[0].value = r.receipt.signatures[0].value.slice(0, 64) }],
  ]
  for (const [name, edit] of tampered) {
    const r = structuredClone(deny)
    edit(r)
    assert.equal(w.verifies(r).valid, false, `tampered (${name}) still verified`)
  }
  const p = structuredClone(permit)
  p.evidence.decision_context.reservation_id = 'res_other'
  assert.equal(w.verifies(p).valid, false, 'permit with a swapped reservation still verified')

  // An outsider re-issues the edited decision under the gate's name with its own key.
  const outsider = { ...makeParty('did:example:outsider', 'gate'), id: w.gateParty.id }
  const forged = structuredClone(deny.evidence)
  forged.decision_context.reason = 'per_request_limit_exceeded'
  const reIssued = issueDecision(outsider, {
    action_ref: deny.receipt.action_ref, prev: deny.receipt.prev!, subject_agent: deny.receipt.subject_agent,
    delegation_ref: deny.receipt.delegation_ref, issued_at: deny.receipt.issued_at, evidence: forged,
  })
  assert.equal(w.verifies(reIssued).valid, false)
  assert.equal(verifyDecision(reIssued, w.gateParty.id, outsider.publicKey).valid, true, 'control: it verifies only under the outsider key')
})
