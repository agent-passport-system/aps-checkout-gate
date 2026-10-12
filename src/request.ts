// The purchase request, its runtime shape check, its digest, and the agent's
// signed intent over it. The intent is an aps:action-intent:v1 receipt, built
// the same way as noncommercial-access-demo/src/gate.ts signIntent. Its
// action_ref is the request digest, so the intent commits to every field of
// this exact request, the amount included.

import { createHash } from 'node:crypto'
import { canonicalizeJCS, createReceiptV1 } from 'agent-passport-system'
import type { AuthorityDelegationV1, ReceiptV1 } from 'agent-passport-system'
import { keyId } from './parties.ts'
import type { Party } from './parties.ts'

export interface LineItem {
  sku: string
  quantity: number
  unit_price_minor: number
}

export interface PurchaseRequest {
  request_id: string
  agent_id: string
  merchant_id: string
  order_ref: string
  items: LineItem[]
  /** Integer minor units, for example cents. Never a float. */
  amount_minor: number
  /** ISO 4217 code, upper case. */
  currency: string
}

const REQUEST_KEYS = ['agent_id', 'amount_minor', 'currency', 'items', 'merchant_id', 'order_ref', 'request_id']
const ITEM_KEYS = ['quantity', 'sku', 'unit_price_minor']

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const hasExactKeys = (v: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(v).sort()
  return k.length === keys.length && k.every((x, i) => x === keys[i])
}
const nonEmpty = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 256
/** A merchant id becomes one scope segment, so it may not hold a colon or a wildcard. */
const SEGMENT = /^[A-Za-z0-9._-]{1,64}$/
const CURRENCY = /^[A-Z]{3}$/
const posInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0
const nonNegInt = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

/** Problems with a request received at runtime. Empty only for an object with
 *  exactly the PurchaseRequest fields, each well formed. Money is integer
 *  minor units: a float, a string or an unsafe integer is refused. */
export function requestShapeProblems(v: unknown): string[] {
  if (!isRecord(v) || !hasExactKeys(v, REQUEST_KEYS)) {
    return [`request is not an object with exactly the fields ${REQUEST_KEYS.join(', ')}`]
  }
  const p: string[] = []
  for (const k of ['request_id', 'agent_id', 'order_ref']) if (!nonEmpty(v[k])) p.push(`${k} is not a non-empty string`)
  if (typeof v.merchant_id !== 'string' || !SEGMENT.test(v.merchant_id)) p.push('merchant_id is not a valid scope segment')
  if (typeof v.currency !== 'string' || !CURRENCY.test(v.currency)) p.push('currency is not an upper case ISO 4217 code')
  if (!posInt(v.amount_minor)) p.push('amount_minor is not a positive safe integer')
  if (!Array.isArray(v.items) || v.items.length === 0 || v.items.length > 100) {
    p.push('items is not a list of 1 to 100 line items')
  } else {
    v.items.forEach((it, i) => {
      if (!isRecord(it) || !hasExactKeys(it, ITEM_KEYS) || !nonEmpty(it.sku) || !posInt(it.quantity) || !nonNegInt(it.unit_price_minor)) {
        p.push(`items[${i}] is not {sku, quantity, unit_price_minor} with integer quantity and minor units`)
      }
    })
  }
  return p
}

export function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

/** sha256 over the RFC 8785 (JCS) form of the request. Two requests with the
 *  same digest are the same request for idempotency. */
export function requestDigest(request: PurchaseRequest): string {
  return sha256Hex(canonicalizeJCS(request))
}

/** The agent's side: sign the request as an aps:action-intent:v1 receipt. */
export function signIntent(request: PurchaseRequest, agent: Party, delegation: AuthorityDelegationV1, issuedAt = new Date()): ReceiptV1 {
  return createReceiptV1(
    {
      profile: 'aps-receipt-v1',
      receipt_type: 'aps:action-intent:v1',
      issuer: agent.id,
      subject_agent: agent.id,
      action_ref: requestDigest(request),
      delegation_ref: delegation.delegation_id,
      issued_at: issuedAt.toISOString(),
      evidence_refs: [],
      result: { profile: 'aps-action-intent-result-v1', status: 'declared' },
    },
    [{ signer: agent.id, key_id: keyId(agent.id), private_key: agent.privateKey }],
  )
}
