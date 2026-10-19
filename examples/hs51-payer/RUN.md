# hs51-payer

APS payer adapter and local rehearsal for ogasurfproject-jpg/horizon-shield#51. The rehearsal is local and is not the run.

Uses the gate in ../../src at d3602027. From the repository root, after `npm ci`:

    node --disable-warning=ExperimentalWarning examples/hs51-payer/rehearsal.ts

What the rehearsal covers: two permitted calls and one budget refusal, identical retries (sequential,
concurrent, after restart, after a lost response) sending once, calls changed after the permit
(occurrence, task, payment amount, payee, payment key, fixture, unit) never sent, and a returned
audit that differs from the signed digest not counted as executed.

Rail: the payment carries a fallback test transfer digest (a hash of a placeholder object, no funds move), SHA-256 of the JCS of
{type signed-test-transfer.v0, request_sha256, amount, unit}, as stub_rail_receipt in horizon-shield
pilot_rehearsal.py at d7e640d1 builds it, and the payer refuses to send a payment whose rail digest is not
the one for its own occurrence. The rail callback is a pure receipt builder, run once per payment
statement. Toshi settled the construction on #51 (comment 6256765798): no x402 rail sits behind the pilot
endpoint, so the run uses this fallback, the stub is unsigned and carried by digest, and only the payment
statement is signed. 725c546b in live_smoke/call.json is a placeholder. The payer keeps payment.json and
the stub bytes as rail-receipt.json per occurrence before claiming the ledger row, and sends nothing if
they cannot be written or no keeper is configured. One private copy of the call is checked, kept and sent.
A failed write spends the occurrence: the gate keeps its decision, a retry returns gate_replay and sends
nothing, and recovery uses a new occurrence_id. The rehearsal reproduces his live-smoke-0 stub: 153 bytes, sha256 ebed1932.

Not covered: any rail that moves testnet funds,
the acceptance check, #51 case B (a mismatched deliverable), the live endpoint.

vendor/pilot-fe8050a5.mjs is horizon-shield workers/hs-pilot/src/pilot.mjs at fe8050a5 (git blob 8e3bf434). It is MIT licensed, copyright The HORIZONs Co., Ltd., see vendor/LICENSE-horizon-shield.
vendor/fixture-fe8050a5.json is the #51 fixture, sha256 c2ed811e...c581.

    node examples/hs51-payer/recompute-caseA.mjs

calls the public MCP server (audit_estimate, read only) through the vendored auditFixture with no region
and prints the case A audit digest. On 2026-10-18 it gave c2920477...37f5, 1532 bytes, matching #51.
