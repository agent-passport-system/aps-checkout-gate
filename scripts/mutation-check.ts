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
  // Optional settlement receipt on 'placed' (src/settlement.ts, test/17).
  {
    name: "(R1) settlement requirement ignored: 'placed' commits without a receipt",
    edits: [{ file: GATE, find: 'if (cfg === null || row.unit !== spendUnit(cfg.unit)) return null', replace: 'return null /* MUTANT (R1) */' }],
  },
  {
    name: '(R2) order binding removed: a receipt for any order commits this one',
    edits: [{ file: 'src/settlement.ts', find: "if (c.terms_hash !== 'sha256:' + ctx.action_ref) {", replace: 'if (false /* MUTANT (R2) */) {' }],
  },
  {
    name: '(R3) one-payment-one-order removed: one settlement commits several orders',
    edits: [{ file: GATE, find: "if (used && used.reservation_id !== row.reservation_id) return 'receipt_settlement_reused'", replace: '/* MUTANT (R3) */' }],
  },
  {
    name: '(R4) amount check removed',
    edits: [{ file: 'src/settlement.ts', find: 'if (c.amount_matches !== true || got !== want) {', replace: 'if (false /* MUTANT (R4) */) {' }],
  },
  {
    name: '(R5) receipt signature check removed',
    edits: [{ file: 'src/settlement.ts', find: "  if (!schnorrVerify(Buffer.from(ev.id, 'hex'), Buffer.from(ev.pubkey, 'hex'), Buffer.from(ev.sig, 'hex'))) {\n    return [{ code: 'receipt_invalid'", replace: "  if (false /* MUTANT (R5) */) {\n    return [{ code: 'receipt_invalid'" }],
  },
  {
    name: '(R6) payee check removed',
    edits: [{ file: 'src/settlement.ts', find: "if (c.payee_matches !== true || lc(c.observed_payee) !== cfg.payee) {", replace: 'if (false /* MUTANT (R6) */) {' }],
  },
  // Optional required evidence: an independent signed verdict on the request (src/verdict.ts, test/11).
  {
    name: '(V1) evidence checks ignored: a configured gate permits without its evidence',
    edits: [{ file: GATE, find: 'if (this.evidenceChecks.length > 0) {\n        // Required evidence', replace: 'if (false /* MUTANT (V1) */) {\n        // Required evidence' }],
  },
  {
    name: '(V2) request binding removed: a verdict on any request passes',
    edits: [{ file: 'src/verdict.ts', find: "if (c.action_binding_args_hash !== 'sha256:' + actionRef) {", replace: 'if (false /* MUTANT (V2) */) {' }],
  },
  {
    name: '(V3) agent binding removed',
    edits: [{ file: 'src/verdict.ts', find: 'if (c.action_binding_agent_id !== req.agent_id) {', replace: 'if (false /* MUTANT (V3) */) {' }],
  },
  {
    name: '(V4) proceed_on removed: any verdict, even reject, allows a permit',
    edits: [{ file: 'src/verdict.ts', find: "if (typeof c.verdict !== 'string' || !allowed.includes(c.verdict)) {", replace: 'if (false /* MUTANT (V4) */) {' }],
  },
  {
    name: '(V5) signature check removed',
    edits: [{ file: 'src/verdict.ts', find: "if (!schnorrVerify(Buffer.from(ev.id, 'hex'), Buffer.from(ev.pubkey, 'hex'), Buffer.from(ev.sig, 'hex'))) {", replace: 'if (false /* MUTANT (V5) */) {' }],
  },
  {
    name: '(V6) event id recompute removed: edited content keeps a valid signature over the old id',
    edits: [{ file: 'src/verdict.ts', find: 'if (eventId(ev) !== ev.id) return', replace: 'if (false /* MUTANT (V6) */) return' }],
  },
  {
    name: '(V7) reviewer key check removed: any key may sign',
    edits: [{ file: 'src/verdict.ts', find: 'if (ev.pubkey !== cfg.verifierPubkey.toLowerCase()) return', replace: 'if (false /* MUTANT (V7) */) return' }],
  },
  {
    name: '(V8) verdict age check removed',
    edits: [{ file: 'src/verdict.ts', find: '} else if (now.getTime() - verifiedMs > (cfg.maxAgeMs ?? DEFAULT_VERDICT_MAX_AGE_MS)) {', replace: '} else if (false /* MUTANT (V8) */) {' }],
  },
  {
    name: '(V9) future-dated verdict check removed',
    edits: [{ file: 'src/verdict.ts', find: '} else if (verifiedMs - now.getTime() > (cfg.maxSkewMs ?? DEFAULT_VERDICT_MAX_SKEW_MS)) {', replace: '} else if (false /* MUTANT (V9) */) {' }],
  },
  // The evidence hook (src/evidence.ts, test/13).
  {
    name: '(E1) missing evidence passed to the check instead of refused',
    edits: [{ file: 'src/evidence.ts', find: 'if (evidence === undefined) {', replace: 'if (false /* MUTANT (E1) */) {' }],
  },
  {
    name: '(E2) a check that throws is not caught',
    edits: [{ file: 'src/evidence.ts', find: '  } catch (e) {\n    return', replace: '  } catch (e) {\n    throw e /* MUTANT (E2) */\n    return' }],
  },
  {
    name: '(E3) a malformed check result is trusted',
    edits: [{ file: 'src/evidence.ts', find: '  if (r === null) {', replace: '  if (false /* MUTANT (E3) */) {' }],
  },
  {
    name: '(E4) all supplied evidence is copied, so unused evidence can change the decision',
    edits: [{ file: GATE, find: 'if (this.evidenceChecks.length > 0) {\n        const supplied', replace: 'if (input?.evidence !== undefined) { evidence.set(\'all\', structuredClone(input.evidence)) /* MUTANT (E4) */ }\n      if (this.evidenceChecks.length > 0) {\n        const supplied' }],
  },
  {
    name: '(E5) each check gets the gate\'s request object instead of a copy',
    edits: [{ file: GATE, find: 'runCheck(c, { request: structuredClone(request),', replace: 'runCheck(c, { request /* MUTANT (E5) */,' }],
  },
  // Hardening after the 12f5023 review (test/14).
  {
    name: '(H1) evidence is not copied apart from the input: a check can reach the caller\'s request',
    edits: [{ file: GATE, find: 'evidence.set(c.name, v === undefined ? undefined : deserialize(serialize(v)))', replace: 'evidence.set(c.name, v) // MUTANT (H1)' }],
  },
  {
    name: '(H2) reserved check names accepted: __proto__ resolves through Object.prototype',
    edits: [{ file: 'src/evidence.ts', find: 'if (RESERVED(name)) throw', replace: 'if (false /* MUTANT (H2) */) throw' }],
  },
  {
    name: '(H3) the check result is inspected outside the guard, so a throwing getter escapes decide()',
    edits: [
      { file: 'src/evidence.ts', find: '    r = normalize(c.check({ ...input, evidence }))', replace: '    r = c.check({ ...input, evidence }) as never // MUTANT (H3)' },
      { file: 'src/evidence.ts', find: '  if (r === null) {', replace: '  r = normalize(r) // MUTANT (H3)\n  if (r === null) {' },
    ],
  },
  {
    name: '(H4) verdict time limits not validated: a string limit turns freshness off',
    edits: [{ file: 'src/verdict.ts', find: "if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw", replace: 'if (false /* MUTANT (H4) */) throw' }],
  },
  {
    name: '(H5) proceedOn not validated: a string matches by substring',
    edits: [{ file: 'src/verdict.ts', find: "if (!Array.isArray(proceedOn) || proceedOn.length === 0 || !proceedOn.every(v => typeof v === 'string' && v.length > 0)) {", replace: 'if (false /* MUTANT (H5) */) {' }],
  },
  {
    name: '(H6) shared memory copied with structuredClone: one check can change another check\'s evidence',
    edits: [{ file: GATE, find: 'evidence.set(c.name, v === undefined ? undefined : deserialize(serialize(v)))', replace: 'evidence.set(c.name, v === undefined ? undefined : structuredClone(v)) // MUTANT (H6)' }],
  },
  {
    name: '(H7) check not bound to its object: a class-based adapter loses its this',
    edits: [{ file: 'src/evidence.ts', find: "check: (check as EvidenceCheck['check']).bind(c) }", replace: "check: check as EvidenceCheck['check'] /* MUTANT (H7) */ }" }],
  },
  // Local store per-order cap adapter (src/priorseal-limit.ts, test/15).
  {
    name: '(S1) store-cap merchant match removed',
    edits: [{ file: 'src/priorseal-limit.ts', find: 'if (request.merchant_id !== cap.merchant_id) {', replace: 'if (false /* MUTANT (S1) */) {' }],
  },
  {
    name: '(S2) store-cap currency match removed',
    edits: [{ file: 'src/priorseal-limit.ts', find: 'if (request.currency !== cap.currency) {', replace: 'if (false /* MUTANT (S2) */) {' }],
  },
  {
    name: '(S3) store per-order amount cap removed',
    edits: [{ file: 'src/priorseal-limit.ts', find: 'if (request.amount_minor > cap.max_amount_minor) {', replace: 'if (false /* MUTANT (S3) */) {' }],
  },
  {
    name: '(S4) store cap snapshot equality removed',
    edits: [{ file: 'src/priorseal-limit.ts', find: 'if (!isCapSnapshot(evidence) || !sameCap(evidence, cap)) {', replace: 'if (false /* MUTANT (S4) */) {' }],
  },
  {
    name: '(S5) cap omitted from the store-cap evidence-id preimage',
    edits: [{ file: 'src/priorseal-limit.ts', find: '    cap,', replace: '    // MUTANT (S5): cap omitted' }],
  },
  {
    name: '(S6) exact request action_ref omitted from the store-cap evidence-id preimage',
    edits: [{ file: 'src/priorseal-limit.ts', find: '    action_ref: actionRef,', replace: '    // MUTANT (S6): action_ref omitted' }],
  },
  {
    name: '(D1) a refusal without a usable delegation id cites an invalid delegation_ref again (decide() throws)',
    edits: [{ file: GATE, find: 'delegation_ref: grantId !== null && /^sha256:[0-9a-f]{64}$/.test(grantId) ? grantId : NO_DELEGATION_REF,', replace: "delegation_ref: grantId ?? 'no-delegation', // MUTANT (D1)" }],
  },
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
    name: '(13) receipt checks removed from the decision verifier',
    edits: [
      { file: 'src/decision.ts', find: 'if (!rv.valid) problems.push(', replace: 'if (false /* MUTANT (13) */) problems.push(' },
      { file: 'src/decision.ts', find: 'if (!cv.valid) problems.push(', replace: 'if (false /* MUTANT (13) */) problems.push(' },
    ],
  },
  {
    name: '(13b) decision_ref binding check removed from the decision verifier',
    edits: [{ file: 'src/decision.ts', find: 'if (!cv.valid) problems.push(', replace: 'if (false /* MUTANT (13b) */) problems.push(' }],
  },
  // Properties added in the second round.
  {
    name: '(14) transient refusals removed: a refusal becomes the idempotency answer',
    edits: [{ file: GATE, find: 'this.store(record, reservationId !== null ? digest : undefined)', replace: 'this.store(record, digest) // MUTANT (14)' }],
  },
  {
    name: '(15) request_id_conflict rule removed: different content under a permitted id is evaluated again',
    edits: [{ file: GATE, find: '      if (prior !== undefined) {', replace: '      if (prior !== undefined && prior.request_digest === digest) { // MUTANT (15)' }],
  },
  {
    name: '(16) line item sum check removed',
    edits: [{ file: GATE, find: 'if (items.problem !== undefined) problems.push(', replace: 'if (false /* MUTANT (16) */) problems.push(' }],
  },
  {
    name: '(17) all-or-none item pricing rule removed',
    edits: [{ file: 'src/request.ts', find: 'if (n !== 0 && n !== v.items.length) p.push(', replace: 'if (false /* MUTANT (17) */) p.push(' }],
  },
  {
    name: '(18) intent staleness check removed',
    edits: [{ file: GATE, find: 'if (now.getTime() - issued > this.intentMaxAgeMs) {', replace: 'if (false /* MUTANT (18) */) {' }],
  },
  {
    name: '(19) intent from the future check removed',
    edits: [{ file: GATE, find: '} else if (issued - now.getTime() > this.intentMaxSkewMs) {', replace: '} else if (false /* MUTANT (19) */) {' }],
  },
  {
    name: '(20) a refusal cites an intent whose signature did not verify',
    edits: [{
      file: GATE,
      find: 'const facts = this.facts(digest, request.request_id, digest, grantId, iv.valid ? snap.intent as ReceiptV1 : null)',
      replace: 'const facts = this.facts(digest, request.request_id, digest, grantId, snap.intent as ReceiptV1) // MUTANT (20)',
    }],
  },
  {
    name: '(21) the decision receipt action_ref no longer binds the request',
    edits: [{
      file: GATE,
      find: 'const facts = this.facts(digest, request.request_id',
      replace: 'const facts = this.facts(UNCANONICAL_REQUEST_REF /* MUTANT (21) */, request.request_id',
    }],
  },
]

const here = resolve(import.meta.dirname, '..')
let survived = 0

for (const m of mutants) {
  const tmp = mkdtempSync(join(tmpdir(), 'checkout-gate-mutant-'))
  try {
    // scripts is copied too, because test 10 runs the demo from scripts/demo.ts.
    for (const d of ['src', 'test', 'scripts']) cpSync(join(here, d), join(tmp, d), { recursive: true })
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
