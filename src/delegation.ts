// A principal grants its agent authority to buy from named merchants, as a
// signed aps:authority-delegation:v1 root record. Same construction as
// noncommercial-access-demo/src/delegation.ts, with a bounded spend facet.
//
// Scope grants name the merchant and the action: checkout:<merchant_id>:purchase.
// A grant checkout:<merchant_id>:* covers every action at that merchant.
// The spend facet carries the money limits in integer minor units:
//   unit        iso4217:<CURRENCY>:minor
//   per_action  the largest single request
//   cumulative  the most the grant may hold reserved, unresolved or committed

import { randomBytes } from 'node:crypto'
import { issueAuthorityDelegation } from 'agent-passport-system'
import type { AuthorityDelegationV1 } from 'agent-passport-system'
import { keyId } from './parties.ts'
import type { Party } from './parties.ts'

export interface GrantTerms {
  grants: string[]
  currency: string
  per_action_minor: number
  cumulative_minor: number
  /** Validity window start. Defaults to the issue time. */
  not_before?: Date
  /** Validity length from not_before. Defaults to one hour. */
  ttl_ms?: number
  issued_at?: Date
}

export const spendUnit = (currency: string) => `iso4217:${currency}:minor`

export function purchaseGrant(merchantId: string): string {
  return `checkout:${merchantId}:purchase`
}

export function issueGrant(principal: Party, agent: Party, t: GrantTerms): AuthorityDelegationV1 {
  for (const v of [t.per_action_minor, t.cumulative_minor]) {
    if (!Number.isSafeInteger(v) || v < 0) throw new RangeError('spend limits are non-negative integer minor units')
  }
  const issued = t.issued_at ?? new Date()
  const start = t.not_before ?? issued
  const iso = (ms: number) => new Date(ms).toISOString()
  return issueAuthorityDelegation(
    {
      record_type: 'aps:authority-delegation:v1',
      version: '1.0',
      parent_delegation_id: null,
      issuer: principal.id,
      subject: agent.id,
      verification_method: keyId(principal.id),
      issued_at: iso(issued.getTime()),
      nonce: randomBytes(16).toString('hex'),
      authority: {
        scope: { profile: 'aps-hierarchical-v1', grants: [...t.grants].sort() },
        spend: {
          mode: 'bounded',
          unit: spendUnit(t.currency),
          per_action: String(t.per_action_minor),
          cumulative: String(t.cumulative_minor),
        },
        depth: { remaining: 0 },
        time: { not_before: iso(start.getTime()), not_after: iso(start.getTime() + (t.ttl_ms ?? 3600_000)) },
        reputation: { profile: 'aps-score-0-100-v1', ceiling: 100 },
        values: { profile: 'aps-values-identifiers-v1', required: [] },
        reversibility: { profile: 'aps-tci-v1', ceiling: 'compensable' },
      },
    },
    principal.privateKey,
  )
}
