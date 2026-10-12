// Self-running demo for a merchant call. No setup, no arguments:
//   npm run demo
// Fresh keys, a temporary sqlite file, the real HTTP server from src/server.ts
// on a free localhost port. The script plays the merchant checkout and the
// customer's agent, and talks to the gate only over HTTP.
//
// Exit code 0 only when every step matched its expected result, 1 when any
// step did not, 2 when the demo could not run at all.
// DEMO_OUT_DIR overrides where the receipts are written (the test uses it).

import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { verifyDecision } from '../src/decision.ts'
import type { DecisionRecord } from '../src/decision.ts'
import { issueGrant, purchaseGrant } from '../src/delegation.ts'
import { Gate } from '../src/gate.ts'
import type { DecideInput } from '../src/gate.ts'
import { makeParty, trustedKeys } from '../src/parties.ts'
import { signIntent } from '../src/request.ts'
import type { LineItem, PurchaseRequest } from '../src/request.ts'
import { createGateServer } from '../src/server.ts'

const MERCHANT = 'demo-store'
const CURRENCY = 'USD'
const LIMIT = 10_000
const PER_PURCHASE = 6_000

/** Integer minor units shown as 45.00. */
function money(minor: number | bigint | string): string {
  const m = BigInt(minor)
  const a = m < 0n ? -m : m
  return `${m < 0n ? '-' : ''}${a / 100n}.${(a % 100n).toString().padStart(2, '0')}`
}

interface Row {
  step: string
  what: string
  expected: string
  got: string
  held: string
  receipt: string
  ok: boolean
}

interface Decided {
  verdict?: string
  reason?: string
  reservation_id?: string | null
  replay?: boolean
  decision?: DecisionRecord
}

async function main(): Promise<number> {
  const tmp = mkdtempSync(join(tmpdir(), 'checkout-gate-demo-'))
  const gateParty = makeParty('did:example:demo-store-gate', 'gate')
  const customer = makeParty('did:example:customer', 'principal')
  const agent = makeParty('did:example:shopping-agent', 'agent')
  const gate = Gate.open({ dbPath: join(tmp, 'gate.db'), gate: gateParty, directory: trustedKeys([gateParty, customer, agent]) })
  const server = createGateServer(gate)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  try {
    const get = async (path: string) => (await fetch(base + path)).json() as Promise<Record<string, any>>
    const post = async (path: string, body: unknown) =>
      (await fetch(base + path, { method: 'POST', body: JSON.stringify(body) })).json() as Promise<Record<string, any>>

    console.log('Checkout gate demo. Fresh keys, a temporary database and the real HTTP server, all on this machine.')
    console.log(`Gate listening on ${base}`)

    // The customer's grant to the agent: demo-store only, 100.00 in total, 60.00 per purchase, one hour.
    const grant = issueGrant(customer, agent, {
      grants: [purchaseGrant(MERCHANT)], currency: CURRENCY,
      per_action_minor: PER_PURCHASE, cumulative_minor: LIMIT, ttl_ms: 3600_000,
    })
    console.log(`The customer lets the shopping agent buy at ${MERCHANT}: up to ${money(LIMIT)} ${CURRENCY} in total, ${money(PER_PURCHASE)} per purchase, for 1 hour.`)
    console.log('')

    let n = 0
    const order = (items: LineItem[], merchant = MERCHANT): PurchaseRequest => {
      n++
      return {
        request_id: `demo-${n}-${randomBytes(4).toString('hex')}`,
        agent_id: agent.id,
        merchant_id: merchant,
        order_ref: `order-${1000 + n}`,
        items,
        amount_minor: items.reduce((s, it) => s + it.quantity * (it.unit_price_minor ?? 0), 0),
        currency: CURRENCY,
      }
    }
    // The agent signs its intent over the exact request, then the checkout sends both to the gate.
    const sign = (request: PurchaseRequest): DecideInput => ({ request, delegation: grant, intent: signIntent(request, agent, grant) })
    const decide = (input: DecideInput) => post('/decide', input) as Promise<Decided>
    const held = async () => (await get(`/budget?grant_id=${encodeURIComponent(grant.delegation_id)}`)).held as string
    const heldOf = (h: string) => `${money(h)} of ${money(LIMIT)}`
    const stateOf = async (id: string | null | undefined) => (id ? (await get(`/reservations/${id}`)).state as string : 'none')

    const rows: Row[] = []
    const received: { step: string; record: DecisionRecord }[] = []
    const keep = (step: string, d: Decided) => { if (d.decision) received.push({ step, record: d.decision }) }
    const say = (line: string) => console.log(line)
    const show = (d: Decided) => d.verdict === 'permit' ? 'PERMIT' : d.verdict === 'deny' ? `REFUSED (${d.reason})` : 'no decision'

    // a. 45.00, order placed.
    const a = await decide(sign(order([{ sku: 'coffee-beans', quantity: 2, unit_price_minor: 1500 }, { sku: 'grinder-brush', quantity: 1, unit_price_minor: 1500 }])))
    keep('a', a)
    const aOut = await post('/outcome', { reservation_id: a.reservation_id, outcome: 'placed', confirmation: { platform_ref: 'order-1001' } })
    let h = await held()
    say(`a. Agent buys 45.00 at ${MERCHANT}: ${show(a)}. The store places the order, reservation ${aOut.state ?? 'not recorded'}. Budget held ${heldOf(h)}.`)
    rows.push({ step: 'a', what: 'Buy 45.00, order placed', expected: 'permit, committed', got: `${a.verdict}, ${aOut.state}`, held: h, receipt: '', ok: a.verdict === 'permit' && aOut.state === 'committed' && h === '4500' })

    // b. 40.00, the payment provider times out.
    const b = await decide(sign(order([{ sku: 'kettle', quantity: 1, unit_price_minor: 4000 }])))
    keep('b', b)
    const bOut = await post('/outcome', { reservation_id: b.reservation_id, outcome: 'timeout' })
    h = await held()
    say(`b. Agent buys 40.00: ${show(b)}. The payment provider times out, reservation ${bOut.state ?? 'not recorded'}, so the 40.00 stays held. Budget held ${heldOf(h)}.`)
    rows.push({ step: 'b', what: 'Buy 40.00, provider timeout', expected: 'permit, unresolved', got: `${b.verdict}, ${bOut.state}`, held: h, receipt: '', ok: b.verdict === 'permit' && bOut.state === 'unresolved' && h === '8500' })

    // c. 30.00 does not fit while b is unresolved.
    const cInput = sign(order([{ sku: 'mugs', quantity: 2, unit_price_minor: 1500 }]))
    const c = await decide(cInput)
    keep('c', c)
    h = await held()
    say(`c. Agent buys 30.00: ${show(c)}, because 85.00 + 30.00 is over 100.00. The refusal is signed too. Budget held ${heldOf(h)}.`)
    rows.push({ step: 'c', what: 'Buy 30.00', expected: 'refused budget_exceeded', got: c.verdict === 'deny' ? `refused ${c.reason}` : String(c.verdict), held: h, receipt: '', ok: c.verdict === 'deny' && c.reason === 'budget_exceeded' && h === '8500' })

    // d. The provider confirms b failed. Reconcile releases it.
    const d = await post('/reconcile', { reservation_id: b.reservation_id, outcome: 'failed', confirmation: { platform_ref: 'psp-decline-7731' } })
    h = await held()
    say(`d. The provider confirms b failed (ref psp-decline-7731). Reconciled, reservation ${d.state ?? 'not recorded'}. Budget held ${heldOf(h)}.`)
    rows.push({ step: 'd', what: 'Reconcile b as failed', expected: 'released', got: String(d.state ?? d.code), held: h, receipt: 'n/a', ok: d.state === 'released' && h === '4500' })

    // e. The same request as c, sent again unchanged.
    const e = await decide(cInput)
    keep('e', e)
    const eState = await stateOf(e.reservation_id)
    h = await held()
    say(`e. The same 30.00 request as c, sent again unchanged: ${show(e)}. Refusals are not final, so it was checked again. Reservation ${eState}. Budget held ${heldOf(h)}.`)
    rows.push({ step: 'e', what: 'Resend request c', expected: 'permit, reserved', got: `${e.verdict}, ${eState}`, held: h, receipt: '', ok: e.verdict === 'permit' && e.replay === false && eState === 'reserved' && h === '7500' })

    // f. Another merchant.
    const f = await decide(sign(order([{ sku: 'headphones', quantity: 1, unit_price_minor: 1000 }], 'other-store')))
    keep('f', f)
    h = await held()
    say(`f. Agent tries to buy 10.00 at other-store: ${show(f)}. The grant covers ${MERCHANT} only. Budget held ${heldOf(h)}.`)
    rows.push({ step: 'f', what: 'Buy 10.00 at other-store', expected: 'refused out_of_scope', got: f.verdict === 'deny' ? `refused ${f.reason}` : String(f.verdict), held: h, receipt: '', ok: f.verdict === 'deny' && f.reason === 'out_of_scope' && h === '7500' })

    // g. Someone edits c's refusal to say permit.
    const key = await get('/gate-key') as { gate_id: string; key_id: string; public_key: string }
    let tampered: DecisionRecord | undefined
    let tamperedValid = true
    if (c.decision) {
      tampered = structuredClone(c.decision)
      const out = { profile: 'aps-core-decision-output-v1' as const, verdict: 'permit' as const, effective_authority_ref: grant.delegation_id.replace(/^sha256:/, ''), constraints: [], valid_until: new Date(Date.now() + 3600_000).toISOString() }
      tampered.receipt.result = out
      tampered.evidence.decision_output = out
      tampered.evidence.decision_context.reason = 'permitted'
      tampered.evidence.decision_context.reasons = []
      tampered.evidence.decision_context.reservation_id = 'res_forged'
      tamperedValid = verifyDecision(tampered, key.gate_id, key.public_key).valid
    }
    say(`g. A copy of c's refusal is edited to say PERMIT: verification ${tamperedValid ? 'PASSES (wrong)' : 'FAILS, as it should'}.`)
    rows.push({ step: 'g', what: "Edit c's refusal to permit", expected: 'fails verification', got: tamperedValid ? 'verified' : 'fails verification', held: '', receipt: tamperedValid ? 'accepted' : 'rejected', ok: tampered !== undefined && !tamperedValid })

    // Every receipt received, checked with the gate key from /gate-key and
    // against the copy the gate stored.
    let verified = 0
    for (const { step, record } of received) {
      const v = verifyDecision(record, key.gate_id, key.public_key)
      const stored = await get(`/decisions/${record.receipt.receipt_id}`)
      const same = JSON.stringify(stored) === JSON.stringify(record)
      const row = rows.find(r => r.step === step)!
      row.receipt = v.valid && same ? 'verified' : 'FAILED'
      if (v.valid && same) verified++
      else row.ok = false
    }
    for (const r of rows) if (r.receipt === '') { r.receipt = 'missing'; r.ok = false }
    console.log('')
    console.log(`Checked ${received.length} decision receipts with the gate key from /gate-key (${key.key_id}): ${verified} verified.`)
    console.log('')

    const cols: [keyof Row, string][] = [['step', 'Step'], ['what', 'What happened'], ['expected', 'Expected'], ['got', 'Result'], ['held', 'Held / limit'], ['receipt', 'Receipt'], ['ok', 'Match']]
    const cell = (r: Row, k: keyof Row) => k === 'ok' ? (r.ok ? 'yes' : 'NO') : k === 'held' ? (r.held === '' ? '' : `${money(r.held)} / ${money(LIMIT)}`) : String(r[k])
    const width = cols.map(([k, title]) => Math.max(title.length, ...rows.map(r => cell(r, k).length)))
    const line = (vals: string[]) => vals.map((v, i) => v.padEnd(width[i])).join('  ').trimEnd()
    console.log(line(cols.map(([, t]) => t)))
    console.log(line(width.map(w => '-'.repeat(w))))
    for (const r of rows) console.log(line(cols.map(([k]) => cell(r, k))))
    console.log('')

    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const outDir = process.env.DEMO_OUT_DIR ?? resolve(import.meta.dirname, '..', 'out', `demo-${stamp}`)
    mkdirSync(outDir, { recursive: true })
    for (const { step, record } of received) writeFileSync(join(outDir, `step-${step}-decision.json`), JSON.stringify(record, null, 2) + '\n')
    if (tampered) writeFileSync(join(outDir, 'step-g-tampered.json'), JSON.stringify(tampered, null, 2) + '\n')
    writeFileSync(join(outDir, 'gate-key.json'), JSON.stringify(key, null, 2) + '\n')
    writeFileSync(join(outDir, 'grant.json'), JSON.stringify(grant, null, 2) + '\n')
    writeFileSync(join(outDir, 'summary.json'), JSON.stringify({ base, limit_minor: LIMIT, currency: CURRENCY, rows }, null, 2) + '\n')
    const shown = relative(process.cwd(), outDir)
    console.log(`Receipts and evidence written to ${shown.startsWith('..') ? outDir : shown}/`)

    const bad = rows.filter(r => !r.ok).length
    console.log(bad === 0 ? `Result: all ${rows.length} steps matched.` : `Result: ${bad} of ${rows.length} steps did not match.`)
    return bad === 0 ? 0 : 1
  } finally {
    server.close()
    server.closeAllConnections()
    gate.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().then(
  code => { process.exitCode = code },
  e => {
    console.log(`Demo stopped: ${e instanceof Error ? e.message : String(e)}`)
    process.exitCode = 2
  },
)
