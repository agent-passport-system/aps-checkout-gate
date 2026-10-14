// Optional second checkout evidence check: a store-configured per-order ceiling.
// This adapter is local and offline. It neither calls PriorSeal nor verifies a
// signed PriorSeal artifact; the cap is trusted because the store configures it
// independently of the APS grant and the configured copy is compared to the
// per-decision evidence snapshot.

import { createHash } from 'node:crypto'
import { canonicalizeJCS } from 'agent-passport-system'
import type { EvidenceCheck, Problem } from './evidence.ts'
import { isRecord } from './request.ts'

export interface PriorSealOrderCap {
  /** Store-assigned identifier for this configured per-order cap. */
  cap_id: string
  /** One merchant scope segment; this check does not authorize other merchants. */
  merchant_id: string
  /** Upper-case ISO 4217 code; no FX conversion is performed. */
  currency: string
  /** Positive integer minor units. */
  max_amount_minor: number
}

const CAP_KEYS = ['cap_id', 'currency', 'max_amount_minor', 'merchant_id']
const MERCHANT_SEGMENT = /^[A-Za-z0-9._-]{1,64}$/
const ISO_CURRENCY = /^[A-Z]{3}$/

function readCap(value: unknown): Readonly<PriorSealOrderCap> {
  if (!isRecord(value)) throw new Error('the PriorSeal order cap must be an object')
  const keys = Object.keys(value).sort()
  if (keys.length !== CAP_KEYS.length || keys.some((key, i) => key !== CAP_KEYS[i])) {
    throw new Error('the PriorSeal order cap must have exactly cap_id, merchant_id, currency and max_amount_minor')
  }
  const { cap_id, merchant_id, currency, max_amount_minor } = value
  if (typeof cap_id !== 'string' || cap_id.length === 0 || cap_id.length > 256) {
    throw new Error('cap_id must be a non-empty string of at most 256 characters')
  }
  if (typeof merchant_id !== 'string' || !MERCHANT_SEGMENT.test(merchant_id)) {
    throw new Error('merchant_id must be one valid merchant scope segment')
  }
  if (typeof currency !== 'string' || !ISO_CURRENCY.test(currency)) {
    throw new Error('currency must be an upper-case ISO 4217 code')
  }
  if (typeof max_amount_minor !== 'number' || !Number.isSafeInteger(max_amount_minor) || max_amount_minor <= 0) {
    throw new Error('max_amount_minor must be a positive safe integer')
  }
  return Object.freeze({ cap_id, merchant_id, currency, max_amount_minor })
}

function isCapSnapshot(value: unknown): value is PriorSealOrderCap {
  if (!isRecord(value)) return false
  const keys = Object.keys(value).sort()
  if (keys.length !== CAP_KEYS.length || keys.some((key, i) => key !== CAP_KEYS[i])) return false
  return typeof value.cap_id === 'string' && typeof value.merchant_id === 'string' &&
    typeof value.currency === 'string' && typeof value.max_amount_minor === 'number' &&
    Number.isSafeInteger(value.max_amount_minor)
}

function sameCap(a: PriorSealOrderCap, b: PriorSealOrderCap): boolean {
  return a.cap_id === b.cap_id && a.merchant_id === b.merchant_id && a.currency === b.currency &&
    a.max_amount_minor === b.max_amount_minor
}

function capEvidenceId(actionRef: string, cap: PriorSealOrderCap): string {
  const preimage = {
    schema: 'priorseal:order-limit-check:v1',
    action_ref: actionRef,
    cap,
  }
  const digest = createHash('sha256').update(canonicalizeJCS(preimage), 'utf8').digest('hex')
  return `sha256:${digest}`
}

/**
 * Build an optional required evidence check for a store-configured per-order
 * cap. Supply an exact snapshot of the configured cap as
 * `evidence.priorseal_limit` on each `Gate.decide` call. The snapshot cannot
 * raise or replace the cap: it must equal this independently configured
 * value. A passing check binds the cap and exact request action_ref into the
 * decision's required_evidence id.
 *
 * This is a local sandbox amount/merchant/currency check, not verification of
 * a signed PriorSeal limit receipt, a second budget reservation, or evidence
 * that an order was placed or paid.
 */
export function priorsealLimitCheck(config: PriorSealOrderCap, name = 'priorseal_limit'): EvidenceCheck {
  const cap = readCap(config)
  return {
    name,
    check: ({ request, evidence, action_ref }) => {
      const problems: Problem[] = []
      if (!isCapSnapshot(evidence) || !sameCap(evidence, cap)) {
        return {
          problems: [{ code: 'priorseal_cap_evidence_invalid', message: 'the supplied cap snapshot does not match the configured store cap' }],
          evidence_id: null,
        }
      }

      if (request.merchant_id !== cap.merchant_id) {
        problems.push({ code: 'priorseal_limit_merchant_mismatch', message: 'the request merchant does not match the configured order cap' })
      }
      if (request.currency !== cap.currency) {
        problems.push({ code: 'priorseal_limit_currency_mismatch', message: 'the request currency does not match the configured order cap' })
      }
      if (request.amount_minor > cap.max_amount_minor) {
        problems.push({ code: 'priorseal_order_limit_exceeded', message: 'the request amount exceeds the configured per-order cap' })
      }
      return { problems, evidence_id: capEvidenceId(action_ref, cap) }
    },
  }
}
