# Demo

`npm run demo` plays one merchant checkout against the gate, start to finish, in about a second. It needs no setup and no arguments.

## Run it

After `npm install`, one command:

```
npm run demo
```

It needs Node 24. It creates fresh keys for the customer, the shopping agent and the gate, a temporary sqlite file, and starts the real HTTP server from `src/server.ts` on a free localhost port. The script then acts as the merchant checkout and the customer's agent and talks to the gate only over HTTP. It exits 0 only when every step matched its expected result.

## What it shows

The customer lets the agent buy at `demo-store`, up to 100.00 in total and 60.00 per purchase, for one hour.

| step | what happens | what it shows |
| --- | --- | --- |
| a | 45.00, the store places the order | a permit, then the reservation is committed |
| b | 40.00, the payment provider times out | an unknown outcome keeps the money held, nothing is released by a timeout |
| c | 30.00 | refused `budget_exceeded`, because 85.00 is held. The refusal is a signed receipt too |
| d | the provider confirms b failed | reconcile with a platform reference releases the 40.00 |
| e | the same request as c, unchanged | a refusal is not final. The request is checked again and now permitted |
| f | 10.00 at `other-store` | refused `out_of_scope`. The grant names one merchant |
| g | c's refusal edited to say permit | verification fails under the gate's key |

At the end the demo fetches the gate's public key from `/gate-key`, verifies every decision receipt it received, and checks each one against the copy the gate stored. It prints a table, and writes the receipts with their decision evidence, the tampered copy, the grant and the gate key to `out/demo-<timestamp>/` as JSON. No private key is written.

## Sample output

Verbatim from a run on 2026-10-12 (Node v24.11.1, Apple Silicon Mac). The port and the folder name change on every run.

```

> aps-checkout-gate@0.1.0 demo
> node --disable-warning=ExperimentalWarning scripts/demo.ts

Checkout gate demo. Fresh keys, a temporary database and the real HTTP server, all on this machine.
Gate listening on http://127.0.0.1:61255
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

Receipts and evidence written to out/demo-2026-10-12T20-55-05-475Z/
Result: all 7 steps matched.
exit 0
```

The last line, `exit 0`, is the shell's exit code, printed after the run.

## What it does not show

- Settlement. A permit means the gate reserved budget under the grant. It does not show that money moved or that goods shipped.
- A real platform. The checkout, the payment provider and its confirmation reference are played by the script. The gate records a confirmation as given and cannot check it.
- More than one host. Everything runs on one machine against one sqlite file. Atomicity and durability across hosts are not established.
- Concurrency and crash recovery. Those are covered by the test suite (tests 2 and 3), not by the demo.
- Key management. Keys are generated fresh on each run and discarded.
- Real identities. Every party is a `did:example` placeholder.
