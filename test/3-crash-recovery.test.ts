import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { world } from './helpers.ts'

const WORKER = resolve(import.meta.dirname, 'workers/reserve-then-hang.ts')

test('3. crash between reserve and order: restart marks it unresolved and the budget stays held', { timeout: 30_000 }, async t => {
  const w = world()
  t.after(() => w.cleanup())
  const grant = w.grant({ per_action_minor: 10_000, cumulative_minor: 10_000 })
  w.open().close()
  const fixture = join(w.dir, 'crash.json')
  writeFileSync(fixture, JSON.stringify({
    dbPath: w.dbPath, gate: w.gateParty, directory: w.directory,
    input: w.input(w.request({ amount_minor: 8000 }), grant),
  }))

  // The child reserves, says so, and is killed before it reports any outcome.
  const child = spawn(process.execPath, ['--no-warnings', WORKER, fixture], { stdio: ['ignore', 'pipe', 'pipe'] })
  const line = await new Promise<string>((res, rej) => {
    let out = ''
    child.stdout.on('data', d => {
      out += d
      if (out.includes('\n')) res(out.trim())
    })
    child.stderr.on('data', d => { out += d })
    child.on('exit', code => rej(new Error(`child exited ${code} before reserving: ${out}`)))
  })
  const reserved = JSON.parse(line) as { verdict: string; reservation_id: string }
  assert.equal(reserved.verdict, 'permit')
  child.removeAllListeners('exit')
  const exited = new Promise(res => child.on('exit', (_c, sig) => res(sig)))
  child.kill('SIGKILL')
  assert.equal(await exited, 'SIGKILL')

  // The committed row survived the kill as 'reserved'. Read it without the
  // gate, so no recovery has run yet.
  const raw = new DatabaseSync(w.dbPath, { readOnly: true })
  const row = raw.prepare('SELECT state, amount_minor FROM reservations WHERE reservation_id = ?').get(reserved.reservation_id) as { state: string; amount_minor: number }
  raw.close()
  assert.deepEqual({ ...row }, { state: 'reserved', amount_minor: 8000 })

  // Restart. The recovery window has passed, so recovery runs on that row.
  w.clock.t += 60_000
  const gate = w.open({ recoveryWindowMs: 30_000 })
  assert.deepEqual(gate.recovered, [reserved.reservation_id])
  assert.equal(gate.reservation(reserved.reservation_id)?.state, 'unresolved')
  assert.equal(gate.budget(grant.delegation_id).unresolved, '8000')
  assert.equal(gate.budget(grant.delegation_id).held, '8000')

  // A request that needs the held budget is refused, signed, and reserves nothing.
  const next = w.request({ amount_minor: 5000 })
  const record = gate.decide(w.input(next, grant))
  assert.equal(record.verdict, 'deny')
  assert.equal(record.reason, 'budget_exceeded')
  assert.equal(gate.reservationForRequest(next.request_id), undefined)

  // An outcome report cannot move it. Only reconcile with confirmation can.
  assert.equal(gate.reportOutcome(reserved.reservation_id, 'failed', { platform_ref: 'late' }).code, 'invalid_state')
  assert.equal(gate.reconcile(reserved.reservation_id, { outcome: 'failed' } as never).code, 'confirmation_required')
  assert.equal(gate.reservation(reserved.reservation_id)?.state, 'unresolved')
})

test('3b. recovery leaves a reservation younger than the window alone', t => {
  const w = world()
  t.after(() => w.cleanup())
  const grant = w.grant()
  const g1 = w.open()
  const record = g1.decide(w.input(w.request(), grant))
  g1.close()
  w.clock.t += 10_000
  const g2 = w.open({ recoveryWindowMs: 30_000 })
  assert.deepEqual(g2.recovered, [])
  assert.equal(g2.reservation(record.reservation_id!)?.state, 'reserved')
})
