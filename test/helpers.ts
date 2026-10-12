// Shared test setup: fresh keys, a temporary sqlite file, a controllable clock.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AuthorityDelegationV1 } from 'agent-passport-system'
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
  input(request: PurchaseRequest, delegation: AuthorityDelegationV1, signer?: Party, intentOver?: PurchaseRequest): DecideInput
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
      return {
        request_id: `req-${process.pid}-${seq}-${Math.random().toString(16).slice(2, 10)}`,
        agent_id: agent.id,
        merchant_id: MERCHANT,
        order_ref: `order-${seq}`,
        items: [{ sku: 'sku-1', quantity: 1, unit_price_minor: 3000 }],
        amount_minor: 3000,
        currency: 'USD',
        ...over,
      }
    },
    input(request, delegation, signer = agent, intentOver) {
      return { request, delegation, intent: signIntent(intentOver ?? request, signer, delegation, new Date(clock.t)) }
    },
    cleanup() {
      for (const g of opened) { try { g.close() } catch { /* closed already */ } }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
