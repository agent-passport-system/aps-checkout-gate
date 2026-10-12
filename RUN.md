# RUN

Recorded run on 2026-10-12 on Tima-MacBook-Air.local (arm64), Node v24.11.1, npm 10.9.9, at commit 150c39394568a0f011af2bd95d12e98c157c4db3 with a clean working tree. Every block below is the verbatim output of the command above it, copied from the log file the command wrote.

The commands ran in one detached shell from the repository root.

```
npm test                 > out/run/test.log;          echo $? > out/run/test.exit
npm run typecheck        > out/run/typecheck.log;     echo $? > out/run/typecheck.exit
npm run demo             > out/run/demo.log;          echo $? > out/run/demo.exit
node --disable-warning=ExperimentalWarning src/server.ts > out/run/server-noarg.log; echo $? > out/run/server-noarg.exit
npm run mutation         > out/run/mutation.log;      echo $? > out/run/mutation.exit
```

## Exit codes

| command | exit code |
| --- | --- |
| npm test | 0 |
| npm run typecheck | 0 |
| npm run demo | 0 |
| node src/server.ts with no config (usage error, expected 2) | 2 |
| npm run mutation | 0 |

Test count: 31 tests, 31 pass, 0 fail. Mutation: 24 mutants, 24 killed, 0 survived. Test 10 runs the demo, so the demo is part of every mutant run, and it failed under 5 of the 24 mutants.

Earlier records. At commit 50c56937d35d341031656c68f35118e9ed9ce603 the suite had 21 tests and 15 mutants. At d983c2c511146daa166afbf4e98715286562f888 it had 30 tests and 24 mutants. Every run exited 0. Their logs are replaced by this one.

How the two transaction mutants fail, from manual runs of test 2 on the tree just before 50c5693, not in the logs below. With IMMEDIATE replaced by a deferred BEGIN, workers threw `database is locked`. With the transaction removed, 8 of 8 workers were permitted where 3 fit (`actual: 8, expected: 3`). The concurrency and crash tests passed 8 of 8 consecutive runs on that tree.

## npm test

```

> aps-checkout-gate@0.1.0 test
> node --disable-warning=ExperimentalWarning --test 'test/*.test.ts'

✔ 1. happy path: permit, reservation reserved, outcome placed moves it to committed (71.2525ms)
✔ 10. npm run demo runs every step over HTTP and exits 0 (650.569042ms)
✔ 2. concurrency: separate processes on one db file never reserve past the grant limit (3570.860709ms)
✔ 3. crash between reserve and order: restart marks it unresolved and the budget stays held (417.704084ms)
✔ 3b. recovery leaves a reservation younger than the window alone (8.779542ms)
✔ 4. timeout: reservation becomes unresolved, budget held, reconcile failed releases it (23.15625ms)
✔ 4. unknown: reservation becomes unresolved, budget held, reconcile failed releases it (11.816042ms)
✔ 4b. budget freed by reconcile can be reserved again (14.118708ms)
✔ 4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release (19.038333ms)
✔ 5. expired grant is refused (44.212917ms)
✔ 5. revoked grant is refused (18.728792ms)
✔ 5. merchant out of scope is refused (19.492875ms)
✔ 5. action out of scope is refused: a refund grant does not cover purchase (7.621542ms)
✔ 5. amount over the per-request limit is refused (30.945667ms)
✔ 5. intent signed by a different agent is refused (47.961416ms)
✔ 5. intent for a different amount is refused (52.674875ms)
✔ 5. other refusals: currency, grant subject, untrusted principal, tampered grant, float money (20.563041ms)
✔ 5. a refusal for an intent that does not verify names no agent and no intent (7.257042ms)
✔ 6. idempotent replay of a permit returns the same receipt and reserves once (40.695708ms)
✔ 6. a refusal is not an idempotency answer: budget_exceeded turns into a permit once budget is released (18.605917ms)
✔ 6. different content under a request_id that holds only refusals is evaluated as a new request (24.941875ms)
✔ 6. conflicting replay: different content under a request_id that holds a permit is refused (17.633125ms)
✔ 7. permit and deny receipts verify with the gate key, tampered receipts and evidence fail (73.037167ms)
✔ 8. the HTTP wrapper passes decide, outcome and reconcile through to the core (92.392875ms)
✔ 9. priced line items must sum to amount_minor (51.219ms)
✔ 9. unpriced line items are accepted, and the evidence records that the amount was not cross-checked (5.892916ms)
✔ 9. items that mix priced and unpriced entries are malformed (9.10675ms)
✔ 9. a stale intent is refused, one inside the window is not (8.226541ms)
✔ 9. an intent from the future is refused beyond the skew, accepted inside it (8.022708ms)
✔ 9. the freshness window is configurable (10.618125ms)
✔ 9. a permitted request replays its permit even after its intent has gone stale (4.560167ms)
ℹ tests 31
ℹ suites 0
ℹ pass 31
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 3859.083875
```

## npm run typecheck

```

> aps-checkout-gate@0.1.0 typecheck
> tsc -p .

```

## npm run demo

```

> aps-checkout-gate@0.1.0 demo
> node --disable-warning=ExperimentalWarning scripts/demo.ts

Checkout gate demo. Fresh keys, a temporary database and the real HTTP server, all on this machine.
Gate listening on http://127.0.0.1:61287
The customer lets the shopping agent buy at demo-store: up to 100.00 USD in total, 60.00 per purchase, for 1 hour.

a. Agent buys 45.00 at demo-store: PERMIT. The store places the order, reservation committed. Budget held 45.00 of 100.00.
b. Agent buys 40.00: PERMIT. The payment provider times out, reservation unresolved, so the 40.00 stays held. Budget held 85.00 of 100.00.
c. Agent buys 30.00: REFUSED (budget_exceeded), because 85.00 + 30.00 is over 100.00. The refusal is signed too. Budget held 85.00 of 100.00.
d. The provider confirms b failed (ref psp-decline-7731). Reconciled, reservation released. Budget held 45.00 of 100.00.
e. The same 30.00 request as c, sent again unchanged: PERMIT. Refusals are not final, so it was checked again. Reservation reserved. Budget held 75.00 of 100.00.
f. Agent tries to buy 10.00 at other-store: REFUSED (out_of_scope). The grant covers demo-store only. Budget held 75.00 of 100.00.
g. A copy of c's refusal is edited to say PERMIT: verification FAILS, as it should.

Checked 5 decision receipts with the gate key from /gate-key (did:example:demo-store-gate#key-1): 5 verified.

Step  What happened                Expected                 Result                   Held / limit    Receipt   Match
----  ---------------------------  -----------------------  -----------------------  --------------  --------  -----
a     Buy 45.00, order placed      permit, committed        permit, committed        45.00 / 100.00  verified  yes
b     Buy 40.00, provider timeout  permit, unresolved       permit, unresolved       85.00 / 100.00  verified  yes
c     Buy 30.00                    refused budget_exceeded  refused budget_exceeded  85.00 / 100.00  verified  yes
d     Reconcile b as failed        released                 released                 45.00 / 100.00  n/a       yes
e     Resend request c             permit, reserved         permit, reserved         75.00 / 100.00  verified  yes
f     Buy 10.00 at other-store     refused out_of_scope     refused out_of_scope     75.00 / 100.00  verified  yes
g     Edit c's refusal to permit   fails verification       fails verification                       rejected  yes

Receipts and evidence written to out/demo-2026-10-12T20-56-17-173Z/
Result: all 7 steps matched.
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
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 2. concurrency: separate processes on one db file never reserve past the grant limit
  test exit code under mutant: 1
  mutant killed

Mutant (1b) transaction removed entirely: each statement autocommits
  applied to src/gate.ts: /* MUTANT (1b) no BEGIN */
  applied to src/gate.ts: /* MUTANT (1b) no COMMIT */
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 2. concurrency: separate processes on one db file never reserve past the grant limit
  test exit code under mutant: 1
  mutant killed

Mutant (2) budget sum check removed
  applied to src/gate.ts: if (false /* MUTANT (2) */) {
  ℹ tests 31
  ℹ pass 22
  ℹ fail 9
  ✖ 10. npm run demo runs every step over HTTP and exits 0
  ✖ 2. concurrency: separate processes on one db file never reserve past the grant limit
  ✖ 3. crash between reserve and order: restart marks it unresolved and the budget stays held
  ✖ 4. timeout: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4. unknown: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4b. budget freed by reconcile can be reserved again
  ✖ 6. a refusal is not an idempotency answer: budget_exceeded turns into a permit once budget is released
  ✖ 7. permit and deny receipts verify with the gate key, tampered receipts and evidence fail
  ✖ 8. the HTTP wrapper passes decide, outcome and reconcile through to the core
  test exit code under mutant: 1
  mutant killed

Mutant (3) timeout-holds rule removed: unknown or timeout releases the budget
  applied to src/gate.ts: else if (outcome === 'unknown' || outcome === 'timeout') next = 'released' // MUTANT (3)
  ℹ tests 31
  ℹ pass 25
  ℹ fail 6
  ✖ 10. npm run demo runs every step over HTTP and exits 0
  ✖ 4. timeout: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4. unknown: reservation becomes unresolved, budget held, reconcile failed releases it
  ✖ 4b. budget freed by reconcile can be reserved again
  ✖ 4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release
  ✖ 8. the HTTP wrapper passes decide, outcome and reconcile through to the core
  test exit code under mutant: 1
  mutant killed

Mutant (4) startup recovery rule removed
  applied to src/gate.ts: g.recovered = [] // MUTANT (4)
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 3. crash between reserve and order: restart marks it unresolved and the budget stays held
  test exit code under mutant: 1
  mutant killed

Mutant (5) idempotency check removed (the unique constraints still stand)
  applied to src/gate.ts: const prior = undefined /* MUTANT (5) */ as
  ℹ tests 31
  ℹ pass 27
  ℹ fail 4
  ✖ 6. idempotent replay of a permit returns the same receipt and reserves once
  ✖ 6. a refusal is not an idempotency answer: budget_exceeded turns into a permit once budget is released
  ✖ 6. conflicting replay: different content under a request_id that holds a permit is refused
  ✖ 9. a permitted request replays its permit even after its intent has gone stale
  test exit code under mutant: 1
  mutant killed

Mutant (5b) idempotency check and the unique constraints behind it removed
  applied to src/gate.ts: const prior = undefined /* MUTANT (5b) */ as
  applied to src/gate.ts: request_id TEXT NOT NULL, -- MUTANT (5b)
  applied to src/gate.ts: p('INSERT OR REPLACE /* MUTANT (5b) */ INTO requests (request_id
  ℹ tests 31
  ℹ pass 27
  ℹ fail 4
  ✖ 6. idempotent replay of a permit returns the same receipt and reserves once
  ✖ 6. a refusal is not an idempotency answer: budget_exceeded turns into a permit once budget is released
  ✖ 6. conflicting replay: different content under a request_id that holds a permit is refused
  ✖ 9. a permitted request replays its permit even after its intent has gone stale
  test exit code under mutant: 1
  mutant killed

Mutant (6) recovery releases instead of marking unresolved
  applied to src/gate.ts: this.transition(row, 'released' /* MUTANT (6) */, 'startup_recovery'
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 3. crash between reserve and order: restart marks it unresolved and the budget stays held
  test exit code under mutant: 1
  mutant killed

Mutant (7) a failure report without platform confirmation releases the budget
  applied to src/gate.ts: next = 'released' // MUTANT (7)
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 4c. reconcile placed commits an unresolved reservation, and failed without confirmation does not release
  test exit code under mutant: 1
  mutant killed

Mutant (8) revocation list ignored
  applied to src/gate.ts: return 'active' // MUTANT (8)
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 5. revoked grant is refused
  test exit code under mutant: 1
  mutant killed

Mutant (9) merchant and action scope check removed
  applied to src/gate.ts: if (false /* MUTANT (9) */) {
  ℹ tests 31
  ℹ pass 28
  ℹ fail 3
  ✖ 10. npm run demo runs every step over HTTP and exits 0
  ✖ 5. merchant out of scope is refused
  ✖ 5. action out of scope is refused: a refund grant does not cover purchase
  test exit code under mutant: 1
  mutant killed

Mutant (10) per-request limit check removed
  applied to src/gate.ts: } else if (false /* MUTANT (10) */) {
  ℹ tests 31
  ℹ pass 29
  ℹ fail 2
  ✖ 5. amount over the per-request limit is refused
  ✖ 6. different content under a request_id that holds only refusals is evaluated as a new request
  test exit code under mutant: 1
  mutant killed

Mutant (11) intent signer check removed
  applied to src/gate.ts: if (false /* MUTANT (11) */) {
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 5. intent signed by a different agent is refused
  test exit code under mutant: 1
  mutant killed

Mutant (12) intent binding to the exact request removed
  applied to src/gate.ts: if (false /* MUTANT (12) */) problems.push(
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 5. intent for a different amount is refused
  test exit code under mutant: 1
  mutant killed

Mutant (13) receipt checks removed from the decision verifier
  applied to src/decision.ts: if (false /* MUTANT (13) */) problems.push(
  applied to src/decision.ts: if (false /* MUTANT (13) */) problems.push(
  ℹ tests 31
  ℹ pass 29
  ℹ fail 2
  ✖ 10. npm run demo runs every step over HTTP and exits 0
  ✖ 7. permit and deny receipts verify with the gate key, tampered receipts and evidence fail
  test exit code under mutant: 1
  mutant killed

Mutant (13b) decision_ref binding check removed from the decision verifier
  applied to src/decision.ts: if (false /* MUTANT (13b) */) problems.push(
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 7. permit and deny receipts verify with the gate key, tampered receipts and evidence fail
  test exit code under mutant: 1
  mutant killed

Mutant (14) transient refusals removed: a refusal becomes the idempotency answer
  applied to src/gate.ts: this.store(record, digest) // MUTANT (14)
  ℹ tests 31
  ℹ pass 28
  ℹ fail 3
  ✖ 10. npm run demo runs every step over HTTP and exits 0
  ✖ 6. a refusal is not an idempotency answer: budget_exceeded turns into a permit once budget is released
  ✖ 6. different content under a request_id that holds only refusals is evaluated as a new request
  test exit code under mutant: 1
  mutant killed

Mutant (15) request_id_conflict rule removed: different content under a permitted id is evaluated again
  applied to src/gate.ts: if (prior !== undefined && prior.request_digest === digest) { // MUTANT (15)
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 6. conflicting replay: different content under a request_id that holds a permit is refused
  test exit code under mutant: 1
  mutant killed

Mutant (16) line item sum check removed
  applied to src/gate.ts: if (false /* MUTANT (16) */) problems.push(
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 9. priced line items must sum to amount_minor
  test exit code under mutant: 1
  mutant killed

Mutant (17) all-or-none item pricing rule removed
  applied to src/request.ts: if (false /* MUTANT (17) */) p.push(
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 9. items that mix priced and unpriced entries are malformed
  test exit code under mutant: 1
  mutant killed

Mutant (18) intent staleness check removed
  applied to src/gate.ts: if (false /* MUTANT (18) */) {
  ℹ tests 31
  ℹ pass 29
  ℹ fail 2
  ✖ 9. a stale intent is refused, one inside the window is not
  ✖ 9. the freshness window is configurable
  test exit code under mutant: 1
  mutant killed

Mutant (19) intent from the future check removed
  applied to src/gate.ts: } else if (false /* MUTANT (19) */) {
  ℹ tests 31
  ℹ pass 29
  ℹ fail 2
  ✖ 9. an intent from the future is refused beyond the skew, accepted inside it
  ✖ 9. the freshness window is configurable
  test exit code under mutant: 1
  mutant killed

Mutant (20) a refusal cites an intent whose signature did not verify
  applied to src/gate.ts: const facts = this.facts(digest, request.request_id, digest, grantId, snap.intent as ReceiptV1) // MUTANT (20)
  ℹ tests 31
  ℹ pass 30
  ℹ fail 1
  ✖ 5. a refusal for an intent that does not verify names no agent and no intent
  test exit code under mutant: 1
  mutant killed

Mutant (21) the decision receipt action_ref no longer binds the request
  applied to src/gate.ts: const facts = this.facts(UNCANONICAL_REQUEST_REF /* MUTANT (21) */, request.request_id
  ℹ tests 31
  ℹ pass 28
  ℹ fail 3
  ✖ 1. happy path: permit, reservation reserved, outcome placed moves it to committed
  ✖ 5. a refusal for an intent that does not verify names no agent and no intent
  ✖ 6. conflicting replay: different content under a request_id that holds a permit is refused
  test exit code under mutant: 1
  mutant killed

all 24 mutants killed
```
