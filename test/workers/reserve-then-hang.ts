// Child process for the crash test. Usage:
//   node test/workers/reserve-then-hang.ts <fixture.json>
// Reserves budget through decide(), reports the reservation on stdout, then
// hangs as if it were waiting on the merchant platform. The parent kills it
// with SIGKILL, so it never reports an outcome and never closes the database.

import { readFileSync } from 'node:fs'
import { Gate } from '../../src/gate.ts'

const f = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const gate = Gate.open({ dbPath: f.dbPath, gate: f.gate, directory: f.directory })
const r = gate.decide(f.input)
console.log(JSON.stringify({ verdict: r.verdict, reason: r.reason, reservation_id: r.reservation_id }))
setInterval(() => { /* placing the order, never finishes */ }, 1000)
