// Optional second checkout evidence check: a store-configured per-order ceiling.
// This adapter is local and offline. It neither calls PriorSeal nor verifies a
// signed PriorSeal artifact; the cap is trusted because the store configures it
// independently of the APS grant and the configured copy is compared to the
// per-decision evidence snapshot.

import { createHash } from 'node:crypto'
import { canonicalizeJCS } from 'agent-passport-system'
import type { EvidenceCheck, Problem } from './evidence.ts'
import { isRecord } from './request.ts'

/**
 * Local store configuration for one merchant's per-order ceiling.
 *
 * It is not a PriorSeal receipt, policy, or signed decision. The store is
 * responsible for supplying and changing this configuration.
 */
export interface StoreOrderCap {
  /** Store-assigned identifier for this configured per-order cap. */
  cap_id: string
  /** One merchant scope segment; this check does not authorize other merchants. */
  merchant_id: string
  /** Three upper-case ASCII letters. This adapter does not validate ISO 4217 membership or perform FX conversion. */
  currency: string
  /** Positive integer minor units. */
  max_amount_minor: number
}

/** @deprecated Use StoreOrderCap. This compatibility alias is not a signed PriorSeal artifact. */
export type PriorSealOrderCap = StoreOrderCap

const CAP_KEYS = ['cap_id', 'currency', 'max_amount_minor', 'merchant_id']
const MERCHANT_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/
const CURRENCY_CODE = /^[A-Z]{3}$/

function readCap(value: unknown): Readonly<StoreOrderCap> {
  if (!isRecord(value)) throw new Error('the store order cap must be an object')
  const keys = Object.keys(value).sort()
  if (keys.length !== CAP_KEYS.length || keys.some((key, i) => key !== CAP_KEYS[i])) {
    throw new Error('the store order cap must have exactly cap_id, merchant_id, currency and max_amount_minor')
  }
  const { cap_id, merchant_id, currency, max_amount_minor } = value
  if (typeof cap_id !== 'string' || cap_id.length === 0 || cap_id.length > 256) {
    throw new Error('cap_id must be a non-empty string of at most 256 characters')
  }
  if (typeof merchant_id !== 'string' || !MERCHANT_SEGMENT.test(merchant_id)) {
    throw new Error('merchant_id must be one valid merchant scope segment')
  }
  if (typeof currency !== 'string' || !CURRENCY_CODE.test(currency)) {
    throw new Error('currency must be three upper-case ASCII letters; this adapter does not validate ISO 4217 membership')
  }
  if (typeof max_amount_minor !== 'number' || !Number.isSafeInteger(max_amount_minor) || max_amount_minor <= 0) {
    throw new Error('max_amount_minor must be a positive safe integer')
  }
  return Object.freeze({ cap_id, merchant_id, currency, max_amount_minor })
}

function isCapSnapshot(value: unknown): value is StoreOrderCap {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== CAP_KEYS.length || keys.some((key, i) => key !== CAP_KEYS[i])) return false
  return typeof value.cap_id === 'string' && typeof value.merchant_id === 'string' &&
    typeof value.currency === 'string' && typeof value.max_amount_minor === 'number' &&
    Number.isSafeInteger(value.max_amount_minor)
}

function sameCap(a: StoreOrderCap, b: StoreOrderCap): boolean {
  return a.cap_id === b.cap_id && a.merchant_id === b.merchant_id && a.currency === b.currency &&
    a.max_amount_minor === b.max_amount_minor
}

function capEvidenceId(actionRef: string, cap: StoreOrderCap): string {
  const preimage = {
    schema: 'store:order-cap-check:v1',
    action_ref: actionRef,
    cap,
  }
  const digest = createHash('sha256').update(canonicalizeJCS(preimage), 'utf8').digest('hex')
  return `sha256:${digest}`
}

/**
 * Build an optional required evidence check for a store-configured per-order
 * cap. Supply an exact snapshot of the configured cap as
 * `evidence.store_order_cap` on each `Gate.decide` call. The snapshot cannot
 * raise, replace, or outlive the current cap: it must equal this independently
 * configured value. A passing check binds the cap and exact request action_ref
 * into the decision's required_evidence id.
 *
 * This is a local sandbox amount/merchant/currency check, not a verification
 * of a signed PriorSeal limit receipt or decision, a second budget reservation,
 * or evidence that an order was placed or paid.
 */
export function storeOrderCapCheck(config: StoreOrderCap, name = 'store_order_cap'): EvidenceCheck {
  const cap = readCap(config)
  return {
    name,
    check: ({ request, evidence, action_ref }) => {
      const problems: Problem[] = []
      if (!isCapSnapshot(evidence) || !sameCap(evidence, cap)) {
        return {
          problems: [{ code: 'store_cap_snapshot_invalid', message: 'the supplied cap snapshot does not match the current configured store cap' }],
          evidence_id: null,
        }
      }

      if (request.merchant_id !== cap.merchant_id) {
        problems.push({ code: 'store_cap_merchant_mismatch', message: 'the request merchant does not match the configured store cap' })
      }
      if (request.currency !== cap.currency) {
        problems.push({ code: 'store_cap_currency_mismatch', message: 'the request currency does not match the configured store cap' })
      }
      if (request.amount_minor > cap.max_amount_minor) {
        problems.push({ code: 'store_order_cap_exceeded', message: 'the request amount exceeds the configured per-order cap' })
      }
      return { problems, evidence_id: capEvidenceId(action_ref, cap) }
    },
  }
}

/**
 * @deprecated Use storeOrderCapCheck. This alias preserves the initial PR API;
 * it remains a local store-cap check and does not verify a signed PriorSeal decision.
 */
export function priorsealLimitCheck(config: StoreOrderCap, name = 'priorseal_limit'): EvidenceCheck {
  return storeOrderCapCheck(config, name)
}
