# RUN

Recorded run on 2026-10-12 on Tima-MacBook-Air.local, Node v24.11.1, npm 10.9.9, at commit 50c56937d35d341031656c68f35118e9ed9ce603 with a clean working tree. Every block below is the verbatim output of the command above it, copied from the log file the command wrote.

The commands ran in one detached shell from the repository root.

```
npm test                 > out/test.log;          echo $? > out/test.exit
npm run typecheck        > out/typecheck.log;     echo $? > out/typecheck.exit
node --disable-warning=ExperimentalWarning src/server.ts > out/server-noarg.log; echo $? > out/server-noarg.exit
npm run mutation         > out/mutation.log;      echo $? > out/mutation.exit
```

## Exit codes

| command | exit code |
| --- | --- |
| npm test | 0 |
| npm run typecheck | 0 |
| node src/server.ts with no config (usage error, expected 2) | 2 |
| npm run mutation | 0 |

Test count: 21 tests, 21 pass, 0 fail. Mutation: 15 mutants, 15 killed, 0 survived.

Two mutants on the transaction fail the concurrency test in different ways. With IMMEDIATE replaced by a deferred BEGIN, workers threw `database is locked` (a separate manual run of test 2 under that mutant showed `worker threw: database is locked`). With the transaction removed, 8 of 8 workers were permitted where 3 fit (manual run showed `actual: 8, expected: 3`). Those two manual runs are not in the logs below. The concurrency and crash tests also passed 8 of 8 consecutive runs. The manual runs and the repeat runs used the tree just before this commit, which differs from it by one TypeScript cast in `recover()` and the typecheck setup.

## npm test

```

> aps-checkout-gate@0.1.0 test
> node --disable-warning=ExperimentalWarning --test 'test/*.test.ts'

✔ 1. happy path: permit, reservation reserved, outcome placed moves it to committed (18.681667ms)
✔ 2. concurrency: separate processes on one db file never reserve past the grant limit (3672.874292ms)
✔ 3. crash between reserve and order: restart marks it unresolved and the budget stays held (454.794042ms)
✔ 3b. recovery leaves a reservation younger than the window alone (5.598375ms)
✔ 4. timeout: reservation becomes unresolved, budget held, reconcile failed releases it (33.25375ms)
✔ 4. unknown: reservation becomes unresolved, budget held, reconcile failed releases it (27.333792ms)
✔ 4b. budget freed by reconcile can be reserved again (10.595625ms)
✔ 4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release (10.840333ms)
✔ 5. expired grant is refused (33.25825ms)
✔ 5. revoked grant is refused (21.491833ms)
✔ 5. merchant out of scope is refused (12.527125ms)
✔ 5. action out of scope is refused: a refund grant does not cover purchase (10.303ms)
✔ 5. amount over the per-request limit is refused (13.418375ms)
✔ 5. intent signed by a different agent is refused (11.630209ms)
✔ 5. intent for a different amount is refused (15.489667ms)
✔ 5. other refusals: currency, grant subject, untrusted principal, tampered grant, float money (17.169291ms)
✔ 6. idempotent replay returns the same decision and reserves once (24.975125ms)
✔ 6. a refused request replays as the same refusal (12.814417ms)
✔ 6. conflicting replay: same request_id, different content, is refused (9.525542ms)
✔ 7. permit and refusal records verify with the gate public key, tampered records fail (43.5935ms)
✔ 8. the HTTP wrapper passes decide, outcome and reconcile through to the core (65.727417ms)
ℹ tests 21
ℹ suites 0
ℹ pass 21
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3947.227125
```

## npm run typecheck

```

> aps-checkout-gate@0.1.0 typecheck
> tsc -p .

```

## node src/server.ts (no config)

```
usage: node src/server.ts <config.json>
```

## npm run mutation

```

> aps-checkout-gate@0.1.0 mutation
> node scripts/mutation-check.ts

Mutant (1) IMMEDIATE removed: transactions start deferred
  applied to src/gate.ts: this.db.exec('BEGIN') // MUTANT (1)
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 2. concurrency: separate processes on one db file never reserve past the grant limit
  test exit code under mutant: 1
  mutant killed

Mutant (1b) transaction removed entirely: each statement autocommits
  applied to src/gate.ts: /* MUTANT (1b) no BEGIN */
  applied to src/gate.ts: /* MUTANT (1b) no COMMIT */
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 2. concurrency: separate processes on one db file never reserve past the grant limit
  test exit code under mutant: 1
  mutant killed

Mutant (2) budget sum check removed
  applied to src/gate.ts: if (false /* MUTANT (2) */) {
  ℹ tests 21
  ℹ pass 14
  ℹ fail 7
  ✖ 2. concurrency: separate processes on one db file never reserve past the grant limit
  ✖ 3. crash between reserve and order: restart marks it unresolved and the budget stays held
  ✖ 4. timeout: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4. unknown: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4b. budget freed by reconcile can be reserved again
  ✖ 7. permit and refusal records verify with the gate public key, tampered records fail
  ✖ 8. the HTTP wrapper passes decide, outcome and reconcile through to the core
  test exit code under mutant: 1
  mutant killed

Mutant (3) timeout-holds rule removed: unknown or timeout releases the budget
  applied to src/gate.ts: else if (outcome === 'unknown' || outcome === 'timeout') next = 'released' // MUTANT (3)
  ℹ tests 21
  ℹ pass 16
  ℹ fail 5
  ✖ 4. timeout: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4. unknown: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4b. budget freed by reconcile can be reserved again
  ✖ 4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release
  ✖ 8. the HTTP wrapper passes decide, outcome and reconcile through to the core
  test exit code under mutant: 1
  mutant killed

Mutant (4) startup recovery rule removed
  applied to src/gate.ts: g.recovered = [] // MUTANT (4)
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 3. crash between reserve and order: restart marks it unresolved and the budget stays held
  test exit code under mutant: 1
  mutant killed

Mutant (5) idempotency check removed (the unique constraints still stand)
  applied to src/gate.ts: const prior = undefined /* MUTANT (5) */ as
  ℹ tests 21
  ℹ pass 18
  ℹ fail 3
  ✖ 6. idempotent replay returns the same decision and reserves once
  ✖ 6. a refused request replays as the same refusal
  ✖ 6. conflicting replay: same request_id, different content, is refused
  test exit code under mutant: 1
  mutant killed

Mutant (5b) idempotency check and the unique constraints behind it removed
  applied to src/gate.ts: const prior = undefined /* MUTANT (5b) */ as
  applied to src/gate.ts: request_id TEXT NOT NULL, -- MUTANT (5b)
  applied to src/gate.ts: p('INSERT OR REPLACE /* MUTANT (5b) */ INTO requests (request_id
  ℹ tests 21
  ℹ pass 18
  ℹ fail 3
  ✖ 6. idempotent replay returns the same decision and reserves once
  ✖ 6. a refused request replays as the same refusal
  ✖ 6. conflicting replay: same request_id, different content, is refused
  test exit code under mutant: 1
  mutant killed

Mutant (6) recovery releases instead of marking unresolved
  applied to src/gate.ts: this.transition(row, 'released' /* MUTANT (6) */, 'startup_recovery'
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 3. crash between reserve and order: restart marks it unresolved and the budget stays held
  test exit code under mutant: 1
  mutant killed

Mutant (7) a failure report without platform confirmation releases the budget
  applied to src/gate.ts: next = 'released' // MUTANT (7)
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release
  test exit code under mutant: 1
  mutant killed

Mutant (8) revocation list ignored
  applied to src/gate.ts: return 'active' // MUTANT (8)
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 5. revoked grant is refused
  test exit code under mutant: 1
  mutant killed

Mutant (9) merchant and action scope check removed
  applied to src/gate.ts: if (false /* MUTANT (9) */) {
  ℹ tests 21
  ℹ pass 19
  ℹ fail 2
  ✖ 5. merchant out of scope is refused
  ✖ 5. action out of scope is refused: a refund grant does not cover purchase
  test exit code under mutant: 1
  mutant killed

Mutant (10) per-request limit check removed
  applied to src/gate.ts: } else if (false /* MUTANT (10) */) {
  ℹ tests 21
  ℹ pass 19
  ℹ fail 2
  ✖ 5. amount over the per-request limit is refused
  ✖ 6. a refused request replays as the same refusal
  test exit code under mutant: 1
  mutant killed

Mutant (11) intent signer check removed
  applied to src/gate.ts: if (false /* MUTANT (11) */) {
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 5. intent signed by a different agent is refused
  test exit code under mutant: 1
  mutant killed

Mutant (12) intent binding to the exact request removed
  applied to src/gate.ts: if (false /* MUTANT (12) */) problems.push(
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 5. intent for a different amount is refused
  test exit code under mutant: 1
  mutant killed

Mutant (13) decision signature check removed from the verifier
  applied to src/decision.ts: if (false /* MUTANT (13) */) problems.push('decision signature
  ℹ tests 21
  ℹ pass 20
  ℹ fail 1
  ✖ 7. permit and refusal records verify with the gate public key, tampered records fail
  test exit code under mutant: 1
  mutant killed

all 15 mutants killed
```
