// Optional required evidence: an independent signed verdict on the exact request.
//
// A store can configure the gate to require, before it permits, a verdict from an
// independent reviewer (here, invinoveritas /review with sign=true) on the purchase
// request itself. The verdict is a Nostr event (NIP-01) signed with BIP-340. Its
// content commits to the request through action_binding_args_hash, which is
// "sha256:" + sha256 over the RFC 8785 JCS form of the request: the same digest this
// gate already uses as action_ref. So "this verdict is about this request" is one
// string comparison, and every check below is offline. Nothing calls the reviewer at
// decision time.
//
// What a passing verdict establishes: the configured reviewer key signed a verdict in
// proceed_on, for exactly this request and this agent, within the age limit. It does
// not establish that the verdict is correct, that the reviewer saw anything beyond the
// request, or anything about payment or fulfilment.

import { createHash } from 'node:crypto'
import { isRecord } from './request.ts'
import type { EvidenceCheck, Problem } from './evidence.ts'

export interface VerdictRequirement {
  /** The reviewer's BIP-340 x-only public key, 64 hex chars. */
  verifierPubkey: string
  /** Verdicts that allow a permit. Default ['approve']. */
  proceedOn?: string[]
  /** A verdict older than this, by its signed verified_at, is refused. Default 10 minutes. */
  maxAgeMs?: number
  /** A verdict dated further ahead of the gate clock than this is refused. Default 30 seconds. */
  maxSkewMs?: number
}

export const DEFAULT_VERDICT_MAX_AGE_MS = 10 * 60_000
export const DEFAULT_VERDICT_MAX_SKEW_MS = 30_000

export interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: unknown[]
  content: string
  sig: string
}

// ---- BIP-340 verification over secp256k1, BigInt, no dependencies ----

const P = 2n ** 256n - 2n ** 32n - 977n
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
const G: Point = [0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n]
type Point = [bigint, bigint] | null

const mod = (a: bigint, m = P): bigint => ((a % m) + m) % m
function powMod(b: bigint, e: bigint, m: bigint): bigint {
  let r = 1n
  b = mod(b, m)
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m
    b = (b * b) % m
    e >>= 1n
  }
  return r
}
const inv = (a: bigint): bigint => powMod(a, P - 2n, P)

function add(a: Point, b: Point): Point {
  if (a === null) return b
  if (b === null) return a
  if (a[0] === b[0] && a[1] !== b[1]) return null
  const l = a[0] === b[0] && a[1] === b[1]
    ? mod(3n * a[0] * a[0] * inv(2n * a[1]))
    : mod((b[1] - a[1]) * inv(b[0] - a[0]))
  const x = mod(l * l - a[0] - b[0])
  return [x, mod(l * (a[0] - x) - a[1])]
}

function mul(p: Point, k: bigint): Point {
  let r: Point = null
  for (let i = 255n; i >= 0n; i--) {
    r = add(r, r)
    if ((k >> i) & 1n) r = add(r, p)
  }
  return r
}

function liftX(x: bigint): Point {
  if (x >= P) return null
  const c = mod(x * x * x + 7n)
  const y = powMod(c, (P + 1n) / 4n, P)
  if (mod(y * y) !== c) return null
  return [x, y % 2n === 0n ? y : P - y]
}

const sha256 = (b: Uint8Array): Buffer => createHash('sha256').update(b).digest()
function taggedHash(tag: string, data: Uint8Array): Buffer {
  const t = sha256(Buffer.from(tag, 'utf8'))
  return sha256(Buffer.concat([t, t, data]))
}
const toBig = (b: Uint8Array): bigint => BigInt('0x' + Buffer.from(b).toString('hex'))

/** BIP-340 verify, restricted to a 32-byte message (BIP-340 allows any length; NIP-01 signs the 32-byte event id, so a
 *  message of any other length returns false here). 32-byte x-only key, 64-byte signature. */
export function schnorrVerify(msg: Uint8Array, pubkey: Uint8Array, sig: Uint8Array): boolean {
  if (msg.length !== 32 || pubkey.length !== 32 || sig.length !== 64) return false
  const pt = liftX(toBig(pubkey))
  if (pt === null) return false
  const r = toBig(sig.subarray(0, 32))
  const s = toBig(sig.subarray(32))
  if (r >= P || s >= N) return false
  const e = toBig(taggedHash('BIP0340/challenge', Buffer.concat([sig.subarray(0, 32), pubkey, msg]))) % N
  const R = add(mul(G, s), mul(pt, mod(N - e, N)))
  return R !== null && R[1] % 2n === 0n && R[0] === r
}

/** NIP-01 event id: sha256 of the JSON array [0, pubkey, created_at, kind, tags, content]. */
export function eventId(ev: NostrEvent): string {
  return sha256(Buffer.from(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]), 'utf8')).toString('hex')
}

const HEX64 = /^[0-9a-f]{64}$/
const HEX128 = /^[0-9a-f]{128}$/

function isEvent(v: unknown): v is NostrEvent {
  return isRecord(v) && typeof v.id === 'string' && typeof v.pubkey === 'string' && typeof v.sig === 'string' &&
    typeof v.content === 'string' && Number.isSafeInteger(v.created_at) && Number.isSafeInteger(v.kind) && Array.isArray(v.tags)
}

/** Every reason the verdict does not allow this request, in check order. Empty = the verdict allows it. */
export function verdictProblems(ev: unknown, req: { agent_id: string }, actionRef: string, now: Date, cfg: VerdictRequirement): Problem[] {
  if (ev === undefined || ev === null) return [{ code: 'verdict_missing', message: 'this gate requires an independent verdict on the request' }]
  if (!isEvent(ev)) return [{ code: 'verdict_invalid', message: 'the verdict is not a NIP-01 event' }]
  if (!HEX64.test(ev.pubkey) || !HEX64.test(ev.id) || !HEX128.test(ev.sig)) {
    return [{ code: 'verdict_invalid', message: 'the verdict event has a malformed id, pubkey or sig' }]
  }
  if (ev.pubkey !== cfg.verifierPubkey.toLowerCase()) return [{ code: 'verdict_untrusted_key', message: 'the verdict is not signed by the configured reviewer key' }]
  if (eventId(ev) !== ev.id) return [{ code: 'verdict_invalid', message: 'the verdict event id does not recompute' }]
  if (!schnorrVerify(Buffer.from(ev.id, 'hex'), Buffer.from(ev.pubkey, 'hex'), Buffer.from(ev.sig, 'hex'))) {
    return [{ code: 'verdict_invalid', message: 'the BIP-340 signature does not verify' }]
  }
  let c: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(ev.content)
    if (!isRecord(parsed)) throw new Error('not an object')
    c = parsed
  } catch {
    return [{ code: 'verdict_invalid', message: 'the verdict content is not a JSON object' }]
  }
  const problems: Problem[] = []
  if (c.action_binding_args_hash !== 'sha256:' + actionRef) {
    problems.push({ code: 'verdict_request_mismatch', message: 'the verdict does not bind this exact request (action_binding_args_hash)' })
  }
  if (c.action_binding_agent_id !== req.agent_id) {
    problems.push({ code: 'verdict_agent_mismatch', message: 'the verdict names a different agent' })
  }
  const allowed = cfg.proceedOn ?? ['approve']
  if (typeof c.verdict !== 'string' || !allowed.includes(c.verdict)) {
    problems.push({ code: 'verdict_not_allowed', message: `verdict ${String(c.verdict)} is not in proceed_on [${allowed.join(', ')}]` })
  }
  const verifiedMs = typeof c.verified_at === 'number' ? c.verified_at * 1000 : NaN
  if (!Number.isFinite(verifiedMs)) {
    problems.push({ code: 'verdict_invalid', message: 'the verdict has no verified_at' })
  } else if (now.getTime() - verifiedMs > (cfg.maxAgeMs ?? DEFAULT_VERDICT_MAX_AGE_MS)) {
    problems.push({ code: 'verdict_stale', message: `verdict issued ${now.getTime() - verifiedMs} ms ago` })
  } else if (verifiedMs - now.getTime() > (cfg.maxSkewMs ?? DEFAULT_VERDICT_MAX_SKEW_MS)) {
    problems.push({ code: 'verdict_from_future', message: `verdict dated ${verifiedMs - now.getTime()} ms ahead of the gate clock` })
  }
  return problems
}

/** Curve primitives for tests that need to SIGN a verdict (the gate itself only verifies). */
export const secp256k1ForTests = { G, N, mul, taggedHash, toBig }

/** The verdict as an evidence check (src/evidence.ts): supply the event as DecideInput.evidence.verdict. */
export function verdictCheck(cfg: VerdictRequirement, name = 'verdict'): EvidenceCheck {
  if (!HEX64.test(cfg.verifierPubkey.toLowerCase())) throw new Error('verifierPubkey must be a 64-hex BIP-340 x-only key')
  return {
    name,
    check: ({ request, evidence, action_ref, now }) => ({
      problems: verdictProblems(evidence, request, action_ref, now, cfg),
      evidence_id: isRecord(evidence) && typeof evidence.id === 'string' ? evidence.id : null,
    }),
  }
}
