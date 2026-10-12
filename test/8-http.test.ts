import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { verifyDecision } from '../src/decision.ts'
import { createGateServer } from '../src/server.ts'
import { world } from './helpers.ts'

test('8. the HTTP wrapper passes decide, outcome and reconcile through to the core', async t => {
  const w = world()
  const gate = w.open()
  const server = createGateServer(gate)
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  t.after(() => { server.close(); w.cleanup() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: 'POST', body: JSON.stringify(body) })
    return { status: r.status, json: await r.json() as Record<string, any> }
  }

  const key = await (await fetch(`${base}/gate-key`)).json() as { public_key: string }
  assert.equal(key.public_key, w.gateParty.publicKey)

  const grant = w.grant()
  const req = w.request({ amount_minor: 7000 })
  const d = await post('/decide', w.input(req, grant))
  assert.equal(d.status, 200)
  assert.equal(d.json.decision.verdict, 'permit')
  assert.equal(verifyDecision(d.json.decision, key.public_key).valid, true)

  const over = await post('/decide', w.input(w.request({ amount_minor: 4000 }), grant))
  assert.equal(over.json.decision.reason, 'budget_exceeded')

  const rid = d.json.decision.reservation_id
  assert.deepEqual((await post('/outcome', { reservation_id: rid, outcome: 'timeout' })).json.state, 'unresolved')
  assert.equal((await post('/outcome', { reservation_id: rid, outcome: 'placed' })).status, 409)
  const rec = await post('/reconcile', { reservation_id: rid, outcome: 'placed', confirmation: { platform_ref: 'ord-1' } })
  assert.equal(rec.json.state, 'committed')

  const stored = await (await fetch(`${base}/decisions/${d.json.decision.decision_id}`)).json()
  assert.deepEqual(stored, d.json.decision)
  assert.equal((await fetch(base + '/decide', { method: 'POST', body: 'not json' })).status, 400)
})
