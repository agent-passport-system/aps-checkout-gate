// Child process for the concurrency test. Usage:
//   node test/workers/decide.ts <fixture.json> <index>
// Opens its own connection to the shared sqlite file, waits for the common
// start time, runs one decide() and prints one JSON line.

import { readFileSync } from 'node:fs'
import { Gate } from '../../src/gate.ts'

const [fixturePath, indexArg] = process.argv.slice(2)
const f = JSON.parse(readFileSync(fixturePath, 'utf8'))
const gate = Gate.open({ dbPath: f.dbPath, gate: f.gate, directory: f.directory, raceWindowMs: f.raceWindowMs })
const input = f.inputs[Number(indexArg)]
// A worker that is ready only after the start time did not race the others.
const late = Date.now() >= f.startAt
while (Date.now() < f.startAt) { /* spin to the common start */ }
try {
  const r = gate.decide(input)
  console.log(JSON.stringify({ late, verdict: r.verdict, reason: r.reason, reservation_id: r.reservation_id }))
} catch (e) {
  console.log(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }))
} finally {
  gate.close()
}
