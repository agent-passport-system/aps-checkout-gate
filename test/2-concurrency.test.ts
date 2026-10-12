import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { world } from './helpers.ts'

const WORKER = resolve(import.meta.dirname, 'workers/decide.ts')

function run(fixture: string, i: number): Promise<{ code: number | null; out: string }> {
  return new Promise((res, rej) => {
    const c = spawn(process.execPath, ['--no-warnings', WORKER, fixture, String(i)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', d => { out += d })
    c.stderr.on('data', d => { out += d })
    c.on('error', rej)
    c.on('exit', code => res({ code, out }))
  })
}

test('2. concurrency: separate processes on one db file never reserve past the grant limit', { timeout: 40_000 }, async t => {
  const w = world()
  t.after(() => w.cleanup())
  const LIMIT = 10_000
  const AMOUNT = 3000
  const N = 8
  const grant = w.grant({ per_action_minor: 5000, cumulative_minor: LIMIT })
  const inputs = Array.from({ length: N }, () => w.input(w.request({ amount_minor: AMOUNT }), grant))
  // Each request alone is within every limit. Together they are far over.
  assert.ok(AMOUNT <= 5000 && AMOUNT <= LIMIT && N * AMOUNT > LIMIT)

  // The parent creates the file first, so workers only open it.
  w.open().close()
  const fixture = join(w.dir, 'fixture.json')
  writeFileSync(fixture, JSON.stringify({
    dbPath: w.dbPath, gate: w.gateParty, directory: w.directory, inputs,
    raceWindowMs: 40, startAt: Date.now() + 3000,
  }))

  const results = await Promise.all(inputs.map((_, i) => run(fixture, i)))
  const parsed = results.map(r => {
    assert.equal(r.code, 0, r.out)
    return JSON.parse(r.out.trim().split('\n').at(-1)!) as { late?: boolean; verdict?: string; reason?: string; reservation_id?: string | null; error?: string }
  })
  for (const p of parsed) assert.equal(p.error, undefined, `worker threw: ${p.error}`)
  // Every worker was ready before the common start, so they really ran together.
  assert.deepEqual(parsed.map(p => p.late), Array(N).fill(false))

  const permits = parsed.filter(p => p.verdict === 'permit')
  const refusals = parsed.filter(p => p.verdict === 'refuse')
  assert.equal(permits.length, Math.floor(LIMIT / AMOUNT))
  assert.equal(refusals.length, N - Math.floor(LIMIT / AMOUNT))
  for (const r of refusals) assert.equal(r.reason, 'budget_exceeded')

  const gate = w.open()
  const before = gate.budget(grant.delegation_id)
  assert.equal(BigInt(before.reserved), BigInt(permits.length * AMOUNT))
  assert.ok(BigInt(before.held) <= BigInt(LIMIT))
  // Place every permitted order. Committed plus reserved still stays in the limit.
  for (const p of permits) assert.equal(gate.reportOutcome(p.reservation_id!, 'placed', { platform_ref: `o-${p.reservation_id}` }).state, 'committed')
  const after = gate.budget(grant.delegation_id)
  assert.ok(BigInt(after.committed) + BigInt(after.reserved) <= BigInt(LIMIT))
  assert.equal(after.committed, String(permits.length * AMOUNT))
})
