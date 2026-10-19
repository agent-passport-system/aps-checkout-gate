// Local rehearsal of the APS payer for horizon-shield#51. Disposable keys, temp sqlite gate and ledger,
// the worker's own handleCall from fe8050a5 run in process, MCP and block lookups stubbed.
// Covers two permitted calls and one budget refusal. The acceptance case (#51 B) is not exercised here.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { issueGrant, purchaseGrant } from '../../src/delegation.ts'
import { Gate } from '../../src/gate.ts'
import { makeParty, trustedKeys } from '../../src/parties.ts'
// @ts-ignore
import * as hs from './vendor/pilot-fe8050a5.mjs'
import { Ledger, MERCHANT, makeCtx, payOnce, signedTestTransfer, testTransferBytes } from './payer.ts'
import type { RailReceiptBuilder } from './payer.ts'
import type { Ctx } from './payer.ts'

const FIXTURE_SHA = 'c2ed811e1d4beb9ae528abc1dfa15a540af9ec5707f56344d8e58cb552ffc581'
const dir = mkdtempSync(join(tmpdir(), 'hs51-rehearsal-'))
const out: Record<string, unknown> = {}
const opened: { close(): void }[] = []
try {
  const gateParty = makeParty('did:example:aps-gate', 'gate')
  const principal = makeParty('did:example:aps-principal', 'principal')
  const agent = makeParty('did:example:aps-agent', 'agent')
  const directory = trustedKeys([gateParty, principal, agent])
  const gateDb = join(dir, 'gate.db'), ledgerDb = join(dir, 'ledger.db')
  const openGate = () => { const g = Gate.open({ dbPath: gateDb, gate: gateParty, directory, now: () => new Date() }); opened.push(g); return g }
  const openLedger = () => { const l = new Ledger(ledgerDb); opened.push(l); return l }
  const grantOf = (cumulative: number) => issueGrant(principal, agent, { grants: [purchaseGrant(MERCHANT)], currency: 'JPY',
    per_action_minor: 7000, cumulative_minor: cumulative, issued_at: new Date() })

  const responderSeed = randomBytes(32).toString('hex')   // stands in for Toshi's key
  const responder: string = await hs.publicKeyHex(responderSeed)
  const env = { RESPONDER_SEED: responderSeed, PRICE: '7000', UNIT: 'JPY-testnet', MCP_URL: 'stub://mcp', BLOCKS_URL: 'stub://blocks' }
  const seen = { height: 971954, hash: 'ab'.repeat(32) }
  const stubFetch = async (url: string, init?: any) => {
    if (url === 'stub://mcp') {
      const id = JSON.parse(init.body).id
      return new Response(JSON.stringify({ jsonrpc: '2.0', id, result: { structuredContent: { work: 'stub work',
        fair_range: { min: 100, avg: 5000, max: 10000 }, verdict: 'fair', level: 'ok', provenance: { data_version: 'stub' },
        claim: { dataset_sha256: '00'.repeat(32), ruleset: { id: 'stub', version: '0' } } } } }))
    }
    if (url === 'stub://blocks/blocks/tip/height') return new Response(String(seen.height))
    if (url === `stub://blocks/block-height/${seen.height}`) return new Response(seen.hash)
    throw new Error('unexpected fetch ' + url)
  }
  let dispatches = 0
  let railCalls = 0
  const countedRail: RailReceiptBuilder = async (...a) => { railCalls++; return signedTestTransfer(...a) }
  const bodies: any[] = []
  // Every dispatch checks that the payment it carries was kept first, byte for byte.
  const worker = async (body: any) => {
    dispatches++; bodies.push(body)
    assert.equal(readFileSync(join(keptDir, body.payment.request_sha256, 'payment.json'), 'utf8'), hs.jcs(body.payment))
    if (body.payment.rail.kind === 'signed-test-transfer')
      assert.equal(await hs.sha256hex(readFileSync(join(keptDir, body.payment.request_sha256, 'rail-receipt.json'), 'utf8')), body.payment.rail.receipt_sha256)
    return hs.handleCall(body, env, stubFetch)
  }
  const fixture = JSON.parse(readFileSync(new URL('./vendor/fixture-fe8050a5.json', import.meta.url), 'utf8'))
  const gate = openGate(), ledger = openLedger()
  const keptDir = join(dir, 'kept')
  const keep = (requestSha: string, files: Record<string, string>) => {
    mkdirSync(join(keptDir, requestSha), { recursive: true })
    for (const [name, bytes] of Object.entries(files)) writeFileSync(join(keptDir, requestSha, name), bytes)
  }
  const base = { gate, gateParty, agent, responder, price: 7000, unit: 'JPY-testnet', fixture, fixtureSha: FIXTURE_SHA,
    ledger, now: () => new Date(), dispatch: worker, rail: countedRail, keep }
  const ctx: Ctx = await makeCtx({ ...base, grant: grantOf(15000) })
  const nonce = () => randomBytes(32).toString('hex')

  // 1. Two permitted calls and a budget refusal under one grant: 7000 each against 15000.
  const P1 = await payOnce(ctx, 'hs51-aps-1', nonce(), seen)
  const P2 = await payOnce(ctx, 'hs51-aps-2', nonce(), seen)
  const R = await payOnce(ctx, 'hs51-aps-3', nonce(), seen)
  for (const x of [P1, P2]) {
    assert.equal(x.verdict, 'permit'); assert.equal(x.refused, undefined)
    assert.equal(x.execution, 'receipt_verified'); assert.equal(x.budget, 'committed')
    assert.equal(x.result.audit.fixture_sha256, FIXTURE_SHA)
  }
  assert.notEqual(P1.receipt_id, P2.receipt_id); assert.notEqual(P1.requestSha, P2.requestSha)
  assert.equal(R.verdict, 'deny'); assert.equal(R.reason, 'budget_exceeded')
  assert.equal(R.payment, 'none'); assert.equal(R.execution, 'not_sent')
  assert.equal(dispatches, 2)
  // The builder runs once per payment statement: two permits, none for the refused third call.
  assert.equal(railCalls, 2)
  assert.equal(gate.budget(ctx.grant.delegation_id).held, '14000')
  // The payment carries the fallback rail digest for its own occurrence (stub_rail_receipt construction).
  for (const [i, x] of [P1, P2].entries()) {
    const pay = bodies[i].payment
    assert.equal(pay.request_sha256, x.requestSha); assert.equal(pay.rail.kind, 'signed-test-transfer')
    assert.equal(pay.rail.receipt_sha256, await hs.sha256hex(hs.jcs({ type: 'signed-test-transfer.v0', request_sha256: x.requestSha, amount: 7000, unit: 'JPY-testnet' })))
  }
  assert.notEqual(bodies[0].payment.rail.receipt_sha256, bodies[1].payment.rail.receipt_sha256)
  out.rail = bodies.slice(0, 2).map(b => b.payment.rail)
  // The rail receipt bytes and the payment are kept as files, and the kept bytes hash to the signed digest.
  for (const [i, x] of [P1, P2].entries()) {
    const railBytes = readFileSync(join(keptDir, x.requestSha, 'rail-receipt.json'), 'utf8')
    assert.equal(railBytes, testTransferBytes(x.requestSha, 7000, 'JPY-testnet'))
    assert.equal(await hs.sha256hex(railBytes), bodies[i].payment.rail.receipt_sha256)
    assert.equal(readFileSync(join(keptDir, x.requestSha, 'payment.json'), 'utf8'), hs.jcs(bodies[i].payment))
  }
  // Toshi's live-smoke-0 numbers (horizon-shield#51 comment 6256765798): 153 bytes, ebed1932.
  { const b = testTransferBytes('69546501c86296c2029de4f2325f6e561b66efa89fe27fdbfe9f4510104d3d01', 7000, 'JPY-testnet')
    assert.equal(Buffer.byteLength(b, 'utf8'), 153)
    assert.equal(await hs.sha256hex(b), 'ebed19328b7bc057b71a0a69aeaf92a6a7ce63f4491808c7429727a134de0669')
    out.live_smoke_0_rail = { bytes: 153, sha256: 'ebed1932' } }
  out.main = [P1, P2, R].map(x => ({ verdict: x.verdict, reason: x.reason, payment: x.payment, execution: x.execution, acceptance: x.acceptance, budget: x.budget ?? null }))

  const fresh = async (over: Partial<Ctx> = {}) => ({ ...(await makeCtx({ ...base, grant: grantOf(100000) })), ...over })
  const sent = () => dispatches

  // 2. Identical sequential retry sends once.
  { const c = await fresh(); const n = nonce(), d0 = sent()
    const first = await payOnce(c, 'retry', n, seen), second = await payOnce(c, 'retry', n, seen)
    assert.equal(first.execution, 'receipt_verified'); assert.equal(second.refused, 'already_attempted:executed')
    assert.equal(sent() - d0, 1); assert.equal(gate.budget(c.grant.delegation_id).held, '7000')
    out.sequential_retry = { first: first.execution, second: second.refused, sends: sent() - d0 } }

  // 3. Identical concurrent attempts send once.
  { const c = await fresh(); const n = nonce(), d0 = sent()
    const both = await Promise.all([payOnce(c, 'conc', n, seen), payOnce(c, 'conc', n, seen)])
    assert.equal(sent() - d0, 1); assert.equal(both.filter(x => x.execution === 'receipt_verified').length, 1)
    assert.equal(gate.budget(c.grant.delegation_id).held, '7000')
    out.concurrent = { results: both.map(x => x.refused ?? x.execution), sends: sent() - d0 } }

  // 4. After a restart (new gate and ledger handles on the same files) the retry still does not send.
  { const c = await fresh(); const n = nonce()
    await payOnce(c, 'restart', n, seen); const d0 = sent()
    const c2: Ctx = { ...c, gate: openGate(), ledger: openLedger() }
    const again = await payOnce(c2, 'restart', n, seen)
    assert.equal(sent() - d0, 0); assert.ok(again.refused?.startsWith('already_attempted'))
    out.restart = { again: again.refused, sends: sent() - d0 } }

  // 5. A send with no response leaves the budget held and blocks a resend.
  { const c = await fresh({ dispatch: async () => { dispatches++; throw Object.assign(new Error('timeout'), { code: 'timeout' }) } })
    const n = nonce(), d0 = sent()
    const lost = await payOnce(c, 'lost', n, seen), retry = await payOnce(c, 'lost', n, seen)
    assert.equal(lost.execution, 'unknown'); assert.equal(lost.budget, 'unresolved')
    assert.equal(retry.refused, 'already_attempted:unknown'); assert.equal(sent() - d0, 1)
    assert.equal(gate.budget(c.grant.delegation_id).held, '7000')
    out.no_response = { first: lost.execution, budget: lost.budget, retry: retry.refused, sends: sent() - d0 } }

  // 6. A call changed after the permit never leaves the payer, and its reservation is released.
  const other = makeParty('did:example:other', 'agent')
  const tampers: Record<string, [string, (b: any) => Promise<any>]> = {
    occurrence: ['occurrence_not_permitted', async b => ({ ...b, request: { ...b.request, occurrence_id: 'elsewhere' } })],
    payment_amount: ['payment_amount_not_permitted', async b => ({ ...b, payment: await hs.sign({ ...b.payment, amount: 8000 }, agent.privateKey) })],
    task: ['task_not_in_request', async b => ({ ...b, task: { ...b.task, nonce: nonce() } })],
    payee: ['payment_not_to_this_responder', async b => ({ ...b, payment: await hs.sign({ ...b.payment, payee: b.request.caller }, agent.privateKey) })],
    payment_key: ['payment_signature_invalid', async b => ({ ...b, payment: await hs.sign({ ...b.payment }, other.privateKey) })],
    rail: ['rail_receipt_not_this_payment', async b => ({ ...b, payment: await hs.sign({ ...b.payment, rail: { kind: 'signed-test-transfer', receipt_sha256: 'cd'.repeat(32) } }, agent.privateKey) })],
    rail_in_place: ['rail_receipt_not_this_payment', async b => { b.payment.rail.receipt_sha256 = 'ef'.repeat(32); return { ...b, payment: await hs.sign({ ...b.payment }, agent.privateKey) } }],
    fixture: ['fixture_not_frozen_fixture', async b => ({ ...b, fixture: { ...b.fixture, lines: b.fixture.lines.slice(0, 1) } })],
  }
  out.tampered = {}
  for (const [name, [code, t]] of Object.entries(tampers)) {
    const c = await fresh(); const d0 = sent()
    const x = await payOnce(c, 'tamper-' + name, nonce(), seen, t)
    assert.equal(x.refused, code, name); assert.equal(sent() - d0, 0, name)
    assert.equal(x.budget, 'released', name); assert.equal(gate.budget(c.grant.delegation_id).held, '0', name)
    ;(out.tampered as any)[name] = x.refused
  }
  { let code = 'none'
    try { await payOnce({ ...(await fresh()), unit: 'USD-testnet' }, 'unit', nonce(), seen) } catch (e: any) { code = e.code }
    assert.equal(code, 'unit_not_mapped'); (out.tampered as any).unit = code }

  // 6b. If the payment files cannot be written, nothing is sent, the reservation is released and no
  // ledger row is left. The occurrence is spent: a retry is a gate replay, a new occurrence_id recovers.
  { let fail = true
    const c = await fresh({ keep: (s: string, f: Record<string, string>) => { if (fail) throw new Error('disk full'); keep(s, f) } })
    const n = nonce(), d0 = sent()
    const x = await payOnce(c, 'not-kept', n, seen)
    assert.equal(x.refused, 'payment_files_not_kept'); assert.equal(sent() - d0, 0)
    assert.equal(x.budget, 'released'); assert.equal(gate.budget(c.grant.delegation_id).held, '0')
    assert.equal(c.ledger.get(x.requestSha), undefined)
    fail = false
    const again = await payOnce(c, 'not-kept', n, seen)
    assert.equal(again.refused, 'gate_replay'); assert.equal(sent() - d0, 0)
    const recovered = await payOnce(c, 'not-kept-2', nonce(), seen)
    assert.equal(recovered.execution, 'receipt_verified'); assert.equal(sent() - d0, 1)
    out.not_kept = { refused: x.refused, budget: x.budget, retry: again.refused, new_occurrence: recovered.execution, sends: sent() - d0 } }

  // 6c. The fallback rail without a keeper is refused, nothing sent.
  { const c = await fresh({ keep: undefined }); const d0 = sent()
    const x = await payOnce(c, 'no-keeper', nonce(), seen)
    assert.equal(x.refused, 'payment_files_not_kept'); assert.equal(sent() - d0, 0); assert.equal(x.budget, 'released')
    out.no_keeper = { refused: x.refused, sends: sent() - d0 } }

  // 6d. Changing the caller's seen object after the call starts changes nothing that is kept or sent.
  { const s2 = { ...seen }; const d0 = sent()
    const c = await fresh({ keep: async (s: string, f: Record<string, string>) => { keep(s, f); s2.height += 1 } })
    const x = await payOnce(c, 'mutable-seen', nonce(), s2)
    assert.equal(x.execution, 'receipt_verified'); assert.equal(sent() - d0, 1)
    assert.equal(bodies[bodies.length - 1].payment.seen_block.height, seen.height)
    out.mutable_seen = { execution: x.execution, sent_height: bodies[bodies.length - 1].payment.seen_block.height } }

  // 7. A returned audit that is not the one the receipt signs is not counted as executed.
  { const c = await fresh({ dispatch: async (b: any) => { const r = await worker(b); return { ...r, audit: { ...r.audit, total: 1 } } } })
    const x = await payOnce(c, 'altered-audit', nonce(), seen)
    assert.equal(x.execution, 'unbound'); assert.equal(x.refused, 'audit_not_signed_audit'); assert.equal(x.budget, 'unresolved')
    out.altered_audit = { execution: x.execution, refused: x.refused, budget: x.budget } }

  out.total_sends = dispatches
  console.log(JSON.stringify(out, null, 2))
  console.log('REHEARSAL OK')
} finally {
  for (const o of opened) { try { o.close() } catch { /* closed */ } }
  rmSync(dir, { recursive: true, force: true })
}
