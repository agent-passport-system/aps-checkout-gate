# aps-checkout-gate

A local sandbox. One gate sits in front of a merchant's existing checkout and decides whether an agent may buy. It checks the agent's Agent Passport System (APS) grant and the agent's signed intent with the `agent-passport-system` SDK, reserves budget atomically in sqlite, and signs every decision, refusals included. Context is aeoess/agent-governance-vocabulary#199. Nothing here is published or deployed.

## Scope

- One host and one sqlite file are the durability and atomicity boundary. The file runs in WAL mode with `synchronous = FULL`, and every write is one `BEGIN IMMEDIATE` transaction.
- More than one host is NOT_ESTABLISHED. Nothing here coordinates two gates that use two files, or one file over a network share.
- A permit says the gate reserved budget for this request under this grant. It does not show that the payment settled or that the order was fulfilled. Settlement evidence comes from the merchant platform.

## What the gate does

`Gate.decide({request, delegation, intent})` in `src/gate.ts`:

1. Copies the input once with `structuredClone` and checks the request shape. Money is integer minor units. A float, a string or an unsafe integer is refused as `malformed_request`.
2. Verifies the grant with `verifyAuthorityDelegationChain`. That covers the principal's signature, the trust root (the issuer must be a principal in the trust directory), the validity window against the gate clock, and revocation. Revocation is answered from a local `revocations` table, read inside the same transaction.
3. Checks that the grant subject is the requesting agent, that a scope grant covers `checkout:<merchant_id>:purchase` (`scopeGrantCovers`), that the spend facet is bounded in `iso4217:<CURRENCY>:minor`, and that the amount is within `per_action`.
4. Verifies the intent with `verifyReceiptV1`. It must be an `aps:action-intent:v1` receipt issued and signed only by the requesting agent, its `action_ref` must equal sha256 of the JCS form of this exact request, and its `delegation_ref` must name this grant.
5. In one IMMEDIATE transaction it applies idempotency, sums reserved, committed and unresolved amounts for the grant, refuses with `budget_exceeded` when that sum plus the amount exceeds `cumulative`, and otherwise inserts the reservation.
6. Signs a decision record with the gate's Ed25519 key over RFC 8785 (JCS) and stores it. Refusals are signed and stored the same way.

Idempotency. The same `request_id` with the same canonical request returns the stored decision and reserves nothing new. The same `request_id` with different content gets a signed `request_id_conflict` refusal, and the original decision stays the answer for that id. A refused request replays as the same refusal, so a retry after budget frees up needs a new `request_id`.

Outcomes. `reportOutcome(reservation_id, outcome, confirmation?)` acts only on a `reserved` reservation.

| outcome | new state | budget |
| --- | --- | --- |
| `placed` | committed | held |
| `failed` with `{platform_ref}` | released | freed |
| `failed` without confirmation | unresolved | held |
| `unknown` or `timeout` | unresolved | held |

Only `reconcile(reservation_id, {outcome, confirmation})` moves an unresolved reservation, to committed or released, and it requires a confirmation. Nothing releases budget because time passed. Every transition is written to `reservation_events`.

Recovery. When a gate opens its file, any `reserved` row older than the recovery window (default 15 minutes) moves to `unresolved`, never to `released`.

`src/server.ts` is a thin `node:http` wrapper (`/decide`, `/outcome`, `/reconcile`, `/decisions/<id>`, `/gate-key`) bound to 127.0.0.1 with no caller authentication.

## Run it

Needs Node 24. Node runs the TypeScript directly, there is no build step, and state lives in the built in `node:sqlite`. The only runtime dependency is `agent-passport-system` pinned to 7.2.1. TypeScript 5.9.3 and `@types/node` 24.10.1 are pinned development dependencies used only by `npm run typecheck`.

```
npm install
npm test            # node:test, every property in the spec
npm run mutation    # removes one property at a time in scratch copies, each must make a test fail
npm run typecheck
node src/server.ts <config.json>   # {dbPath, gate: {id, role, publicKey, privateKey}, directory, port?}
```

RUN.md has the commands, exit codes, test counts and mutation output from the recorded run.

## SDK functions used

- Keys: `generateKeyPair` in `src/parties.ts`.
- Grant: `issueAuthorityDelegation` in `src/delegation.ts`, verified with `verifyAuthorityDelegationChain` and `scopeGrantCovers` in `src/gate.ts`.
- Intent: `createReceiptV1` in `src/request.ts`, verified with `verifyReceiptV1` in `src/gate.ts`.
- Canonical form and signatures: `canonicalizeJCS`, `sign` and `verify` in `src/request.ts` and `src/decision.ts`.

These follow the patterns in noncommercial-access-demo. No SDK function was added or patched.

## Gaps and deviations from the spec

- The decision record is this sandbox's own profile, `aps-checkout-gate/decision-v1`, signed with the SDK's `sign` over `canonicalizeJCS`. It is not an `aps:policy-decision:v1` receipt.
- Revocation is a local list of delegation ids in sqlite. It does not hold signed `AuthorityRevocationV1` records, and the HTTP wrapper has no revoke endpoint.
- Only single record grants are accepted, a root delegation from a trusted principal straight to the agent. Multi hop chains are not accepted, and budget is tracked per grant id only. The SDK's `cumulative` applies to a whole delegation subtree, which this gate does not model.
- The SDK's bounded spend facet always carries `per_action`. A grant with no separate per-request limit sets `per_action` equal to `cumulative`. A grant with an unbounded spend facet is refused as `no_spend_limit`.
- The budget ledger is sqlite, not the SDK's `InMemoryAuthorityBudgetLedger`, which is single process and in memory.
- A timeout is reported by the caller as outcome `timeout`. The gate runs no timer of its own.
- Platform confirmations are recorded as given. The gate cannot check them. Outcome transitions are logged but not signed.
- The concurrency test uses a test seam, `raceWindowMs`, that busy-waits inside the budget transaction between the sum read and the insert. It is zero in normal use. It makes a missing lock show up every run instead of by scheduler luck. With IMMEDIATE replaced by a deferred BEGIN, the failure the test sees is `database is locked` errors in the workers, not an overspend. With the transaction removed entirely, the test sees 8 permits where 3 fit.
- Startup recovery uses wall time against the window. If a second gate process opens the same file with a short window while another is waiting on the platform, it marks the live reservation unresolved. That direction holds budget and never releases it.
- An idempotent replay is answered from the request digest alone. The replayed intent's signature is not checked again, because the stored decision is returned and nothing new is reserved.
- Line items are shape checked but not summed against `amount_minor`, since tax and shipping can differ.
- Intent freshness is not checked. The intent is bound to the request content, `request_id` included, so a replayed intent meets the idempotency rule.
- `node:sqlite` is marked experimental in Node 24. The npm scripts silence that warning.
- Keys are generated per run in tests. Key storage and rotation are out of scope.

## What this does not establish

- That a payment settled, an order was placed or goods were delivered.
- Atomicity or durability across hosts.
- That a platform confirmation is genuine.
- That any signer is honest. A signature shows which key signed what. The trust directory says whose key it is.

## License

Apache-2.0, see `LICENSE`.
