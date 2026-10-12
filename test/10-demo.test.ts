import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'

const DEMO = resolve(import.meta.dirname, '..', 'scripts', 'demo.ts')

test('10. npm run demo runs every step over HTTP and exits 0', { timeout: 40_000 }, t => {
  const out = mkdtempSync(join(tmpdir(), 'checkout-gate-demo-out-'))
  t.after(() => rmSync(out, { recursive: true, force: true }))
  const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', DEMO], {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, DEMO_OUT_DIR: out },
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(r.stderr, '')
  assert.match(r.stdout, /Result: all 7 steps matched\./)
  assert.match(r.stdout, /Checked 5 decision receipts .*: 5 verified\./)
  // Money is shown in major units, never as raw minor units.
  assert.match(r.stdout, /Budget held 85\.00 of 100\.00/)
  assert.doesNotMatch(r.stdout, /\b4500\b|\b8500\b/)
  // No stack traces in the screen-share output.
  assert.doesNotMatch(r.stdout, /\n\s+at /)

  const files = readdirSync(out).sort()
  assert.deepEqual(files, [
    'gate-key.json', 'grant.json', 'step-a-decision.json', 'step-b-decision.json', 'step-c-decision.json',
    'step-e-decision.json', 'step-f-decision.json', 'step-g-tampered.json', 'summary.json',
  ])
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8')) as { rows: { step: string; ok: boolean }[] }
  assert.deepEqual(summary.rows.map(x => [x.step, x.ok]), [['a', true], ['b', true], ['c', true], ['d', true], ['e', true], ['f', true], ['g', true]])
  // Nothing private is written out.
  for (const f of files) assert.doesNotMatch(readFileSync(join(out, f), 'utf8'), /privateKey|private_key/)
})
