// Shared test setup: fresh keys, a temporary sqlite file, a controllable clock.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthorityDelegationV1 } from 'agent-passport-system'
import { verifyDecision } from '../src/decision.ts'
import { issueGrant, purchaseGrant } from '../src/delegation.ts'
import type { GrantTerms } from '../src/delegation.ts'
import { Gate } from '../src/gate.ts'
import type { DecideInput, GateConfig } from '../src/gate.ts'
import { makeParty, trustedKeys } from '../src/parties.ts'
import type { Party, TrustedKeys } from '../src/parties.ts'
import { signIntent } from '../src/request.ts'
import type { PurchaseRequest } from '../src/request.ts'

export const MERCHANT = 'merchant-a'

export interface World {
  dir: string
  dbPath: string
  gateParty: Party
  principal: Party
  agent: Party
  agentB: Party
  directory: TrustedKeys
  clock: { t: number }
  open(extra?: Partial<GateConfig>): Gate
  grant(terms?: Partial<GrantTerms>, agent?: Party): AuthorityDelegationV1
  request(over?: Partial<PurchaseRequest>): PurchaseRequest
  input(request: PurchaseRequest, delegation: AuthorityDelegationV1, signer?: Party, intentOver?: PurchaseRequest, intentAt?: Date): DecideInput
  verifies(record: unknown): { valid: boolean; problems: string[] }
  cleanup(): void
}

let seq = 0

export function world(): World {
  const dir = mkdtempSync(join(tmpdir(), 'aps-checkout-gate-'))
  const gateParty = makeParty('did:example:gate', 'gate')
  const principal = makeParty('did:example:buyer', 'principal')
  const agent = makeParty('did:example:agent-a', 'agent')
  const agentB = makeParty('did:example:agent-b', 'agent')
  const directory = trustedKeys([gateParty, principal, agent, agentB])
  const clock = { t: Date.now() }
  const dbPath = join(dir, 'gate.db')
  const opened: Gate[] = []
  return {
    dir, dbPath, gateParty, principal, agent, agentB, directory, clock,
    open(extra = {}) {
      const g = Gate.open({ dbPath, gate: gateParty, directory, now: () => new Date(clock.t), ...extra })
      opened.push(g)
      return g
    },
    grant(terms = {}, to = agent) {
      return issueGrant(principal, to, {
        grants: [purchaseGrant(MERCHANT)],
        currency: 'USD',
        per_action_minor: 10_000,
        cumulative_minor: 10_000,
        issued_at: new Date(clock.t),
        ...terms,
      })
    },
    request(over = {}) {
      seq++
      // Priced items that sum to the amount, unless the test sets items itself.
      const amount = over.amount_minor ?? 3000
      const price = Number.isSafeInteger(amount) && amount > 0 ? amount : 3000
      return {
        request_id: `req-${process.pid}-${seq}-${Math.random().toString(16).slice(2, 10)}`,
        agent_id: agent.id,
        merchant_id: MERCHANT,
        order_ref: `order-${seq}`,
        items: [{ sku: 'sku-1', quantity: 1, unit_price_minor: price }],
        amount_minor: amount,
        currency: 'USD',
        ...over,
      }
    },
    verifies(record) {
      return verifyDecision(record, gateParty.id, gateParty.publicKey)
    },
    input(request, delegation, signer = agent, intentOver, intentAt) {
      return { request, delegation, intent: signIntent(intentOver ?? request, signer, delegation, intentAt ?? new Date(clock.t)) }
    },
    cleanup() {
      for (const g of opened) { try { g.close() } catch { /* closed already */ } }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Expects a signed deny receipt with the given reason, no reservation, and the
 *  refusal in the decision log. */
export function expectRefusal(w: World, gate: Gate, input: DecideInput, reason: string) {
  const r = gate.decide(input)
  assert.equal(r.verdict, 'deny', `expected a refusal for ${reason}, got ${r.verdict}`)
  assert.equal(r.reason, reason, r.record.evidence.decision_context.reasons.join(' | '))
  assert.equal(r.reservation_id, null)
  assert.equal(r.record.receipt.receipt_type, 'aps:policy-decision:v1')
  assert.equal(r.record.receipt.result.verdict, 'deny')
  assert.deepEqual(w.verifies(r.record), { valid: true, problems: [] })
  const req = input.request as PurchaseRequest
  assert.equal(gate.reservationForRequest(req.request_id), undefined, 'a refusal must not reserve')
  assert.ok(gate.decisionsForRequest(req.request_id).some(d => d.receipt.receipt_id === r.record.receipt.receipt_id), 'the refusal is stored')
  return r
}

/** A small request the same gate permits, to show the refusal that follows is
 *  caused by the one thing the test changed. */
export function control(w: World, gate: Gate, grant: AuthorityDelegationV1) {
  const r = gate.decide(w.input(w.request({ amount_minor: 100 }), grant))
  assert.equal(r.verdict, 'permit', `control was refused: ${r.record.evidence.decision_context.reasons.join(' | ')}`)
}
