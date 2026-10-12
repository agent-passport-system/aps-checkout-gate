// Mutation check, same method as noncommercial-access-demo/scripts/mutation-check.ts.
// Each mutant removes one property in its own scratch copy of src and test,
// and the whole test suite runs there. A mutant is killed when at least one
// test fails. Exits 0 when every mutant is killed, 1 when any survives, and
// 2 when an edit does not match exactly once (nothing is run then).

import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

interface Edit { file: string; find: string; replace: string }
interface Mutant { name: string; edits: Edit[] }

const GATE = 'src/gate.ts'

const mutants: Mutant[] = [
  // The six properties spec item 8 names.
  {
    name: '(1) IMMEDIATE removed: transactions start deferred',
    edits: [{ file: GATE, find: "this.db.exec('BEGIN IMMEDIATE')", replace: "this.db.exec('BEGIN') // MUTANT (1)" }],
  },
  {
    name: '(1b) transaction removed entirely: each statement autocommits',
    edits: [
      { file: GATE, find: "this.db.exec('BEGIN IMMEDIATE')", replace: '/* MUTANT (1b) no BEGIN */' },
      { file: GATE, find: "      this.db.exec('COMMIT')\n", replace: '      /* MUTANT (1b) no COMMIT */\n' },
    ],
  },
  {
    name: '(2) budget sum check removed',
    edits: [{ file: GATE, find: 'if (held + amount > limit) {', replace: 'if (false /* MUTANT (2) */) {' }],
  },
  {
    name: '(3) timeout-holds rule removed: unknown or timeout releases the budget',
    edits: [{
      file: GATE,
      find: "else if (outcome === 'unknown' || outcome === 'timeout') next = 'unresolved'",
      replace: "else if (outcome === 'unknown' || outcome === 'timeout') next = 'released' // MUTANT (3)",
    }],
  },
  {
    name: '(4) startup recovery rule removed',
    edits: [{ file: GATE, find: 'g.recovered = g.recover()', replace: 'g.recovered = [] // MUTANT (4)' }],
  },
  {
    name: '(5) idempotency check removed (the unique constraints still stand)',
    edits: [{
      file: GATE,
      find: 'const prior = this.q.getRequest.get(request.request_id) as',
      replace: 'const prior = undefined /* MUTANT (5) */ as',
    }],
  },
  {
    name: '(5b) idempotency check and the unique constraints behind it removed',
    edits: [
      { file: GATE, find: 'const prior = this.q.getRequest.get(request.request_id) as', replace: 'const prior = undefined /* MUTANT (5b) */ as' },
      { file: GATE, find: '  request_id TEXT NOT NULL UNIQUE,', replace: '  request_id TEXT NOT NULL, -- MUTANT (5b)' },
      { file: GATE, find: "p('INSERT INTO requests (request_id", replace: "p('INSERT OR REPLACE /* MUTANT (5b) */ INTO requests (request_id" },
    ],
  },
  // Further properties the tests claim.
  {
    name: '(6) recovery releases instead of marking unresolved',
    edits: [{ file: GATE, find: "this.transition(row, 'unresolved', 'startup_recovery'", replace: "this.transition(row, 'released' /* MUTANT (6) */, 'startup_recovery'" }],
  },
  {
    name: '(7) a failure report without platform confirmation releases the budget',
    edits: [{ file: GATE, find: "next = isConfirmation(confirmation) ? 'released' : 'unresolved'", replace: "next = 'released' // MUTANT (7)" }],
  },
  {
    name: '(8) revocation list ignored',
    edits: [{ file: GATE, find: "return this.q.revoked.get(delegationId) === undefined ? 'active' : 'revoked'", replace: "return 'active' // MUTANT (8)" }],
  },
  {
    name: '(9) merchant and action scope check removed',
    edits: [{ file: GATE, find: 'if (!d.authority.scope.grants.some(g => scopeGrantCovers(g, needed))) {', replace: 'if (false /* MUTANT (9) */) {' }],
  },
  {
    name: '(10) per-request limit check removed',
    edits: [{ file: GATE, find: '} else if (BigInt(request.amount_minor) > BigInt(spend.per_action)) {', replace: '} else if (false /* MUTANT (10) */) {' }],
  },
  {
    name: '(11) intent signer check removed',
    edits: [{
      file: GATE,
      find: 'if (intent.issuer !== request.agent_id || intent.subject_agent !== request.agent_id ||\n      signers.length === 0 || !signers.every(s => s === request.agent_id)) {',
      replace: 'if (false /* MUTANT (11) */) {',
    }],
  },
  {
    name: '(12) intent binding to the exact request removed',
    edits: [{ file: GATE, find: 'if (intent.action_ref !== digest) problems.push(', replace: 'if (false /* MUTANT (12) */) problems.push(' }],
  },
  {
    name: '(13) decision signature check removed from the verifier',
    edits: [{ file: 'src/decision.ts', find: "if (!ok) problems.push('decision signature", replace: "if (false /* MUTANT (13) */) problems.push('decision signature" }],
  },
]

const here = resolve(import.meta.dirname, '..')
let survived = 0

for (const m of mutants) {
  const tmp = mkdtempSync(join(tmpdir(), 'checkout-gate-mutant-'))
  try {
    for (const d of ['src', 'test']) cpSync(join(here, d), join(tmp, d), { recursive: true })
    cpSync(join(here, 'package.json'), join(tmp, 'package.json'))
    symlinkSync(join(here, 'node_modules'), join(tmp, 'node_modules'))

    for (const e of m.edits) {
      const target = join(tmp, e.file)
      const src = readFileSync(target, 'utf8')
      const hits = src.split(e.find).length - 1
      if (hits !== 1) {
        console.log(`mutant ${m.name}: not applied, found ${hits} matches for ${JSON.stringify(e.find)} in ${e.file}`)
        process.exit(2)
      }
      writeFileSync(target, src.replace(e.find, () => e.replace))
    }

    const r = spawnSync(process.execPath, ['--no-warnings', '--test', 'test/*.test.ts'], { cwd: tmp, encoding: 'utf8', timeout: 120_000 })
    const out = r.stdout + r.stderr
    const failing = [...new Set(out.split('\n').filter(l => l.startsWith('✖ ') && !l.startsWith('✖ failing tests')))]
      .map(l => l.replace(/ \([\d.]+m?s\)$/, ''))
    const tally = out.split('\n').filter(l => /^ℹ (tests|pass|fail) /.test(l))

    console.log(`Mutant ${m.name}`)
    for (const e of m.edits) console.log(`  applied to ${e.file}: ${e.replace.split('\n').find(l => l.includes('MUTANT'))?.trim()}`)
    for (const t of tally) console.log(`  ${t}`)
    for (const f of failing) console.log(`  ${f}`)
    console.log(`  test exit code under mutant: ${r.status}`)
    if (r.status === 0) {
      survived++
      console.log('  MUTANT SURVIVED: no test failed')
    } else {
      console.log('  mutant killed')
    }
    console.log('')
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

console.log(survived === 0 ? `all ${mutants.length} mutants killed` : `${survived} of ${mutants.length} mutants survived`)
process.exitCode = survived === 0 ? 0 : 1
