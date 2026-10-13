# aps-checkout-gate

A local sandbox. One gate sits in front of a merchant's existing checkout and decides whether an agent may buy. It checks the agent's Agent Passport System (APS) grant and the agent's signed intent with the `agent-passport-system` SDK, reserves budget atomically in sqlite, and signs every decision, refusals included, as an `aps:policy-decision:v1` receipt. Context is aeoess/agent-governance-vocabulary#199. Nothing here is deployed.

## Scope

- One host and one sqlite file are the durability and atomicity boundary. The file runs in WAL mode with `synchronous = FULL`, and every write is one `BEGIN IMMEDIATE` transaction.
- More than one host is NOT_ESTABLISHED. Nothing here coordinates two gates that use two files, or one file over a network share.
- A permit says the gate reserved budget for this request under this grant. It does not show that the payment settled or that the order was fulfilled. Settlement evidence comes from the merchant platform.

## What the gate does

`Gate.decide({request, delegation, intent})` in `src/gate.ts`:

1. Copies the input once with `structuredClone` and checks the request shape. Money is integer minor units. A float, a string or an unsafe integer is refused as `malformed_request`.
2. Verifies the grant with `verifyAuthorityDelegationChain`. That covers the principal's signature, the trust root (the issuer must be a principal in the trust directory), the validity window against the gate clock, and revocation. Revocation is answered from a local `revocations` table, read inside the same transaction.
3. Checks that the grant subject is the requesting agent, that a scope grant covers `checkout:<merchant_id>:purchase` (`scopeGrantCovers`), that the spend facet is bounded in `iso4217:<CURRENCY>:minor`, and that the amount is within `per_action`.
4. Checks the line items. A request prices all of its items or none of them, and a mix is `malformed_request`. When items are priced, the sum of `quantity * unit_price_minor` (computed in BigInt) must equal `amount_minor` exactly, otherwise `items_amount_mismatch`. Tax, shipping and discounts that change the total must then be line items too. When no item carries a price the gate has nothing to cross-check, so it accepts the stated amount, and the decision evidence records `items_priced: false`. The budget and per-request limits still bound that amount.
5. Verifies the intent with `verifyReceiptV1`. It must be an `aps:action-intent:v1` receipt issued and signed only by the requesting agent, its `action_ref` must equal sha256 of the JCS form of this exact request, and its `delegation_ref` must name this grant. Its signed `issued_at` must be no older than `intentMaxAgeMs` (default 5 minutes, `intent_stale`) and no further ahead of the gate clock than `intentMaxSkewMs` (default 30 seconds, `intent_from_future`).
6. In one IMMEDIATE transaction it applies idempotency, sums reserved, committed and unresolved amounts for the grant, refuses with `budget_exceeded` when that sum plus the amount exceeds `cumulative`, and otherwise inserts the reservation.
7. Issues the decision as an `aps:policy-decision:v1` receipt and stores it.

### The decision receipt

Built with `createReceiptV1`, with `decision_ref` from `buildDecisionRefV1` and an `aps-core-decision-output-v1` result.

- `action_ref` is the request digest, sha256 over the JCS form of the request. It is the same value the agent's intent commits to. It is not the SDK's `computeActionRefV2`, because the intent here was never built on that.
- `prev` is the intent's `receipt_id` and `subject_agent` is the intent's agent, but only when the intent signature verifies. Otherwise the receipt cites `unverified-intent` and a fixed hash, so the gate's signature does not lend weight to an unverified claim.
- `delegation_ref` is the grant's `delegation_id`.
- On a permit, `effective_authority_ref` is the grant's digest (the hex part of `delegation_id`), `constraints` is empty, and `valid_until` is the decision time plus the recovery window. After that time startup recovery may move the reservation to unresolved. On a deny, both are null as the SDK requires.

The receipt schema is closed, and a policy decision's result must be exactly the core decision output. So the receipt itself cannot carry the reservation id or the refusal reasons. They live in the decision evidence, which `decision_ref` commits to. `decision_context` holds the reason, every refusal reason and the reservation id. `authority_state` holds the grant id, spend unit, cumulative limit and the held amount before the decision. `policy_input` holds the request id and digest, the cited intent and `items_priced`. The gate stores `{receipt, evidence}` together. `verifyDecision` in `src/decision.ts` checks the pair with `verifyReceiptV1` (signature, closed schema, policy-decision stage rules, boundary identity) and `verifyReceiptWithDecisionV1` (the `decision_ref` binding). It also checks that a permit carries a reservation id and a deny does not.

Receipts are deterministic. The same inputs at the same millisecond give the same `receipt_id` and the same bytes, and such a repeat is stored once.

### Idempotency

Only a permit becomes the idempotency answer for its `request_id`. The same `request_id` with the same canonical request then gets the stored permit back and reserves nothing new, even after the intent has gone stale. Different content under a `request_id` that holds a permit gets a signed `request_id_conflict` refusal.

Refusals are signed and logged but are not answers. A later request with the same `request_id` is evaluated again, whether its content is identical or not. A `budget_exceeded` refusal therefore turns into a permit once budget is released.

### Outcomes

`reportOutcome(reservation_id, outcome, confirmation?)` acts only on a `reserved` reservation.

| outcome | new state | budget |
| --- | --- | --- |
| `placed` | committed | held |
| `failed` with `{platform_ref}` | released | freed |
| `failed` without confirmation | unresolved | held |
| `unknown` or `timeout` | unresolved | held |

Only `reconcile(reservation_id, {outcome, confirmation})` moves an unresolved reservation, to committed or released, and it requires a confirmation. Nothing releases budget because time passed. Every transition is written to `reservation_events`.

### Recovery

When a gate opens its file, any `reserved` row older than the recovery window (default 15 minutes) moves to `unresolved`, never to `released`.

`src/server.ts` is a thin `node:http` wrapper (`/decide`, `/outcome`, `/reconcile`, `/decisions/<receipt_id>`, `/reservations/<reservation_id>`, `/budget?grant_id=`, `/gate-key`) bound to 127.0.0.1 with no caller authentication.

## Optional: required evidence

A store can make a permit also depend on evidence beyond the delegation and the intent. Off by default; with no checks
configured the gate never reads `evidence` and its records are unchanged.

```ts
Gate.open({ ...config, evidenceChecks: [check1, check2] })
gate.decide({ request, delegation, intent, evidence: { [check.name]: ... } })
```

A check (`src/evidence.ts`) is `{ name, check(input) }`. It gets a copy of the request, its own evidence (supplied under its
name), `action_ref` (the JCS digest of the request), the agent and the gate's clock, and returns
`{ problems: [{ code, message }], evidence_id }`. Every check must pass. The gate refuses before any budget is reserved when:

| case | refusal |
| --- | --- |
| no evidence under a configured check's name | `evidence_missing` |
| the check throws, or returns anything but `{ problems, evidence_id }` | `evidence_check_failed` |
| the check returns problems | those problems |

Evidence under a name no configured check uses is never read or copied, so it cannot change the decision. Each decision of a
gate with checks records `policy_input.required_evidence`: per check, its name and the `evidence_id` it returned. Checks run
offline; the gate calls nothing. `test/13-evidence-hook.test.ts` covers the hook.

### First adapter: an independent verdict on the exact request

`verdictCheck` in `src/verdict.ts` requires an independent signed verdict on the request (#199: "independent pre-payment
verdict bound to merchant, order, amount, currency and agent").

```ts
Gate.open({ ...config, evidenceChecks: [verdictCheck({ verifierPubkey: '<reviewer BIP-340 x-only key>', proceedOn: ['approve'], maxAgeMs: 600_000 })] })
gate.decide({ request, delegation, intent, evidence: { verdict } })   // verdict: the reviewer's signed NIP-01 event
```

The server takes the same as `requireVerdict` in its config and `evidence.verdict` in the `/decide` body. The verification key
is pinned in config. BIP-340 verification over secp256k1 is in `src/verdict.ts` with no dependency. It accepts only a 32-byte
message, which is what NIP-01 signs (the event id); BIP-340 itself allows other lengths. `test/12-bip340-vectors.test.ts` runs
the official BIP-340 vectors (bitcoin/bips at `200f9b26fe0a2f235a2af8b30c4be9f12f6bc9cb`, `bip-0340/test-vectors.csv`,
sha256 `34c9d1d9…851c2d`, checked by the test): all 15 with a 32-byte message give the expected result, and the 4 with
another length are refused. A verdict allows the permit only if all of these hold:

| check | refusal |
| --- | --- |
| it is signed by the configured reviewer key | `verdict_untrusted_key` |
| the NIP-01 id recomputes and the BIP-340 signature verifies | `verdict_invalid` |
| its `action_binding_args_hash` is `"sha256:" + action_ref`, the same JCS digest of the request this gate uses | `verdict_request_mismatch` |
| its `action_binding_agent_id` is the request's `agent_id` | `verdict_agent_mismatch` |
| its verdict is in `proceedOn` (default `approve`) | `verdict_not_allowed` |
| its `verified_at`, against the gate's clock, is within `maxAgeMs` (default 10 minutes) and not more than `maxSkewMs` (default 30 seconds) ahead | `verdict_stale`, `verdict_from_future` |

A decision records the verdict's event id as its `evidence_id`. `test/11-verdict.test.ts` covers each refusal with signed
fixtures and no network, and includes a real verdict from invinoveritas `/review`
(`test/vectors/invinoveritas-verdict-b2cd036a.json`), whose `action_binding_args_hash` equals this gate's `requestDigest()` for
the same request. `npm run mutation` removes each verdict check and each hook rule in turn.

A passing verdict establishes only that the configured reviewer signed a verdict in `proceedOn` for exactly this request and
agent, recently. It does not establish that the verdict is right, that the reviewer saw more than the request, or anything about
payment or fulfilment.

## Run it

Needs Node 24. Node runs the TypeScript directly, there is no build step, and state lives in the built in `node:sqlite`. The only runtime dependency is `agent-passport-system` pinned to 7.2.1. TypeScript 5.9.3 and `@types/node` 24.10.1 are pinned development dependencies used only by `npm run typecheck`.

```
npm install
npm run demo        # self-running merchant walkthrough over HTTP, see docs/DEMO.md
npm test            # node:test, every property in the spec
npm run mutation    # removes one property at a time in scratch copies, each must make a test fail
npm run typecheck
node src/server.ts <config.json>   # {dbPath, gate: {id, role, publicKey, privateKey}, directory, port?}
```

`npm run demo` needs no setup and no arguments. It starts the real server on a free localhost port with fresh keys and a temporary database, walks through seven checkout steps, verifies every receipt with the key from `/gate-key`, and exits 0 only when every step matched. docs/DEMO.md explains it and has sample output.

RUN.md has the commands, exit codes, test counts and mutation output from the recorded run.

## SDK functions used

- Keys: `generateKeyPair` in `src/parties.ts`.
- Grant: `issueAuthorityDelegation` in `src/delegation.ts`, verified with `verifyAuthorityDelegationChain` and `scopeGrantCovers` in `src/gate.ts`.
- Intent: `createReceiptV1` in `src/request.ts`, verified with `verifyReceiptV1` in `src/gate.ts`.
- Decision: `buildDecisionRefV1` and `createReceiptV1` in `src/decision.ts`, verified with `verifyReceiptV1` and `verifyReceiptWithDecisionV1` there.
- Canonical form: `canonicalizeJCS` in `src/request.ts` and `src/gate.ts`.

No SDK function was added or patched.

## What this establishes

Within one host and one sqlite file, and as exercised by the tests and the mutation check in RUN.md:

- Concurrent processes never reserve past a grant's cumulative limit.
- A reservation whose outcome is unknown, timed out, or interrupted by a crash keeps holding budget until a confirmed reconcile.
- A permit needs a valid, unrevoked, unexpired grant from a trusted principal, in scope for the merchant and the purchase action, in the request's currency and within its per-request limit, plus a fresh intent signed by the delegated agent over exactly this request.
- Every decision is a signed receipt that verifies with the SDK, and tampering with the receipt or its evidence makes verification fail.

## What this does not establish

- That a payment settled, an order was placed or goods were delivered.
- Atomicity or durability across hosts.
- That a platform confirmation is genuine.
- That unpriced line items match the amount.
- That any signer is honest. A signature shows which key signed what. The trust directory says whose key it is.

## Remaining gaps

- Revocation is a local, unsigned list of delegation ids in sqlite. It does not hold signed `AuthorityRevocationV1` records, and the HTTP wrapper has no revoke endpoint.
- Single host. See Scope.
- Only single record grants are accepted, a root delegation from a trusted principal straight to the agent. Multi hop chains are not accepted, and budget is tracked per grant id only. The SDK's `cumulative` applies to a whole delegation subtree, which this gate does not model.
- The SDK's bounded spend facet always carries `per_action`. A grant with no separate per-request limit sets `per_action` equal to `cumulative`. A grant with an unbounded spend facet is refused as `no_spend_limit`.
- The budget ledger is sqlite, not the SDK's `InMemoryAuthorityBudgetLedger`, which is single process and in memory.
- A timeout is reported by the caller as outcome `timeout`. The gate runs no timer of its own.
- Platform confirmations are recorded as given. Outcome transitions are logged in `reservation_events` but not signed.
- The concurrency test uses a test seam, `raceWindowMs`, that busy-waits inside the budget transaction between the sum read and the insert. It is zero in normal use. With IMMEDIATE replaced by a deferred BEGIN, the failure the test sees is `database is locked` errors in the workers, not an overspend. With the transaction removed entirely, the test sees 8 permits where 3 fit.
- Startup recovery uses wall time against the window. If a second gate process opens the same file with a short window while another is waiting on the platform, it marks the live reservation unresolved. That direction holds budget and never releases it.
- A replayed permit is answered from the request digest alone. The replayed intent is not checked again, because the stored permit is returned and nothing new is reserved.
- Intents carry no nonce of their own. Within the freshness window, a resent intent is answered by the idempotency rule, since the intent is bound to the request content, `request_id` included.
- The decision receipt's `constraints` list is empty. The amount and reservation are bound through the evidence, not stated as constraints.
- `node:sqlite` is marked experimental in Node 24. The npm scripts silence that warning.
- Keys are generated per run in tests. Key storage and rotation are out of scope.

## License

Apache-2.0, see `LICENSE`.
