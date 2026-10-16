// Optional settlement receipt on 'placed': a signed receipt that the payment the permit authorized settled.
//
// A store can configure the gate so that reportOutcome('placed') and reconcile({outcome: 'placed'}) commit a
// reservation only with a signed payment receipt (here, invinoveritas /payment-receipt) for an EIP-3009 payment
// on chain. The receipt is a Nostr event (NIP-01) signed with BIP-340; its content IS the receipt, and only the
// signed content is read. Every check is offline: nothing calls the issuer or the chain at outcome time. The
// receipt reports what the issuer read from the chain when it signed: retry_state from the token's
// authorizationState, settlement_id only when the tx was proven to be the bound payment, and the observed
// Transfer amount and payee.
//
// Binding to this reservation: the receipt's terms_hash must be "sha256:" + the permit's action_ref (the JCS
// digest of the permitted request). The payer supplies terms_hash when it asks for the receipt, so on its own
// the binding is the payer's claim. That is why the gate also records each settlement_id it accepts and refuses
// a second reservation for the same settlement (receipt_settlement_reused): one payment commits one order.
//
// What a passing receipt establishes: the configured issuer signed that this payer's authorization was used on
// chain, by a settlement proven to be that payment, moving the expected amount of the configured asset to the
// configured payee, and that the payer's wallet signed it. It does not establish that the goods were delivered,
// or that the payer meant this order beyond the terms_hash it supplied.

import { isRecord } from './request.ts'
import type { Problem } from './evidence.ts'
import { eventId, schnorrVerify } from './verdict.ts'
import type { NostrEvent } from './verdict.ts'

export interface SettlementRequirement {
  /** The receipt issuer's BIP-340 x-only public key, 64 hex chars. */
  issuerPubkey: string
  /** CAIP-2 network the payment must settle on, for example 'eip155:8453'. */
  network: string
  /** Token contract the payment must use, for example USDC on Base. */
  asset: string
  /** The store's receiving address. */
  payee: string
  /** The currency these rules apply to (ISO 4217, as in the grant; the gate compares it as spendUnit(unit)). Other units commit without a receipt. */
  unit: string
  /** Atomic token units per minor unit of `unit`: 10000 for USD cents paid in USDC (6 decimals). */
  atomicPerMinor: number
  /** Optional: the wallet each agent must pay from. When set, a receipt from any other payer is refused. */
  payerFor?: (agentId: string) => string | undefined
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/
const ADDR = /^0x[0-9a-fA-F]{40}$/
export const RECEIPT_SCHEMA = 'invinoveritas.payment_receipt.v1'

function isEvent(v: unknown): v is NostrEvent {
  return isRecord(v) && typeof v.id === 'string' && typeof v.pubkey === 'string' && typeof v.sig === 'string' &&
    typeof v.content === 'string' && Number.isSafeInteger(v.created_at) && Number.isSafeInteger(v.kind) && Array.isArray(v.tags)
}

/** Checks a SettlementRequirement and returns a frozen copy, so a malformed configuration fails when the gate opens. */
export function validateSettlementRequirement(cfg: unknown): Readonly<SettlementRequirement> {
  if (!isRecord(cfg)) throw new Error('the settlement requirement must be an object')
  const pub = cfg.issuerPubkey
  if (typeof pub !== 'string' || !HEX64.test(pub.toLowerCase())) throw new Error('issuerPubkey must be a 64-hex BIP-340 x-only key')
  if (typeof cfg.network !== 'string' || !/^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/.test(cfg.network)) throw new Error('network must be a CAIP-2 id')
  if (typeof cfg.asset !== 'string' || !ADDR.test(cfg.asset)) throw new Error('asset must be a 0x address')
  if (typeof cfg.payee !== 'string' || !ADDR.test(cfg.payee)) throw new Error('payee must be a 0x address')
  if (typeof cfg.unit !== 'string' || !/^[A-Z]{3}$/.test(cfg.unit)) throw new Error('unit must be an ISO 4217 code')
  const k = cfg.atomicPerMinor
  if (typeof k !== 'number' || !Number.isSafeInteger(k) || k <= 0) throw new Error('atomicPerMinor must be a positive safe integer')
  if (cfg.payerFor !== undefined && typeof cfg.payerFor !== 'function') throw new Error('payerFor must be a function')
  return Object.freeze({
    issuerPubkey: pub.toLowerCase(), network: cfg.network, asset: cfg.asset.toLowerCase(), payee: cfg.payee.toLowerCase(),
    unit: cfg.unit, atomicPerMinor: k, payerFor: cfg.payerFor as SettlementRequirement['payerFor'],
  })
}

/** The facts of the reservation being committed, read by the gate from its own store. */
export interface SettlementContext {
  /** The permitted request's action_ref (sha256 hex of its JCS form). */
  action_ref: string
  agent_id: string
  amount_minor: number
}

/** Every reason the receipt does not prove this reservation's payment, in check order. Empty = it does. */
export function settlementProblems(ev: unknown, ctx: SettlementContext, cfg: Readonly<SettlementRequirement>): Problem[] {
  if (ev === undefined || ev === null) return [{ code: 'receipt_missing', message: "this gate commits 'placed' only with a signed settlement receipt" }]
  if (!isEvent(ev)) return [{ code: 'receipt_invalid', message: 'the receipt is not a NIP-01 event' }]
  if (!HEX64.test(ev.pubkey) || !HEX64.test(ev.id) || !HEX128.test(ev.sig)) {
    return [{ code: 'receipt_invalid', message: 'the receipt event has a malformed id, pubkey or sig' }]
  }
  if (ev.pubkey !== cfg.issuerPubkey) return [{ code: 'receipt_untrusted_key', message: 'the receipt is not signed by the configured issuer key' }]
  if (eventId(ev) !== ev.id) return [{ code: 'receipt_invalid', message: 'the receipt event id does not recompute' }]
  if (!schnorrVerify(Buffer.from(ev.id, 'hex'), Buffer.from(ev.pubkey, 'hex'), Buffer.from(ev.sig, 'hex'))) {
    return [{ code: 'receipt_invalid', message: 'the BIP-340 signature does not verify' }]
  }
  let c: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(ev.content)
    if (!isRecord(parsed)) throw new Error('not an object')
    c = parsed
  } catch {
    return [{ code: 'receipt_invalid', message: 'the receipt content is not a JSON object' }]
  }
  if (c.schema !== RECEIPT_SCHEMA) return [{ code: 'receipt_invalid', message: `the receipt schema is not ${RECEIPT_SCHEMA}` }]
  const lc = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : null)
  const problems: Problem[] = []
  if (c.terms_hash !== 'sha256:' + ctx.action_ref) {
    problems.push({ code: 'receipt_not_bound', message: "the receipt's terms_hash is not sha256:<the permit's action_ref>" })
  }
  if (c.retry_state !== 'paid_do_not_retry') {
    problems.push({ code: 'receipt_not_paid', message: `retry_state is ${String(c.retry_state)}, not paid_do_not_retry` })
  }
  if (c.authorization_used_on_chain !== true || c.settlement_status !== 'valid' || typeof c.settlement_id !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(c.settlement_id)) {
    problems.push({ code: 'receipt_settlement_unproven', message: 'the receipt does not prove a settlement (authorization_used_on_chain, settlement_status valid, settlement_id)' })
  }
  if (c.network !== cfg.network) problems.push({ code: 'receipt_network_mismatch', message: `the payment settled on ${String(c.network)}, not ${cfg.network}` })
  if (lc(c.asset) !== cfg.asset) problems.push({ code: 'receipt_asset_mismatch', message: 'the payment used a different asset' })
  if (c.payee_matches !== true || lc(c.observed_payee) !== cfg.payee) {
    problems.push({ code: 'receipt_payee_mismatch', message: "the observed transfer did not pay this store's address" })
  }
  const want = BigInt(ctx.amount_minor) * BigInt(cfg.atomicPerMinor)
  let got: bigint | null = null
  try { got = typeof c.observed_amount === 'string' && /^[0-9]{1,78}$/.test(c.observed_amount) ? BigInt(c.observed_amount) : null } catch { got = null }
  if (c.amount_matches !== true || got !== want) {
    problems.push({ code: 'receipt_amount_mismatch', message: `the observed transfer is ${String(c.observed_amount)} atomic units, the reservation needs ${want}` })
  }
  const wa = c.wallet_approval
  if (!isRecord(wa) || wa.recovers_to_payer !== true) {
    problems.push({ code: 'receipt_wallet_unapproved', message: "the payer's EIP-3009 signature was not provided or does not recover to the payer" })
  }
  if (cfg.payerFor) {
    const expected = cfg.payerFor(ctx.agent_id)
    if (typeof expected !== 'string' || lc(expected) !== lc(c.payer)) {
      problems.push({ code: 'receipt_payer_mismatch', message: 'the payment came from a wallet this agent is not configured to pay from' })
    }
  }
  return problems
}

/** The settlement_id of a receipt that verified, for the gate's one-payment-one-order record. */
export function settlementIdOf(ev: NostrEvent): string {
  return String((JSON.parse(ev.content) as Record<string, unknown>).settlement_id).toLowerCase()
}
