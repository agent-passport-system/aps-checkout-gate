// Thin node:http wrapper over the gate core. Binds to 127.0.0.1 only and has
// no caller authentication. It is for local experiments, not exposure.
//
//   POST /decide     {request, delegation, intent, evidence?} -> {decision, verdict, reason, reservation_id, replay}
//   POST /outcome    {reservation_id, outcome, confirmation?}  -> OutcomeResult
//   POST /reconcile  {reservation_id, outcome, confirmation}   -> OutcomeResult
//   GET  /decisions/<receipt_id>                              -> {receipt, evidence}
//   GET  /gate-key                                            -> {gate_id, key_id, public_key}
//   GET  /reservations/<reservation_id>                       -> reservation row
//   GET  /budget?grant_id=<delegation_id>                     -> minor units per state, as strings
//
// Run: node src/server.ts <config.json>
// config.json: {dbPath, gate: {id, role, publicKey, privateKey}, directory, port?, requireVerdict?: {verifierPubkey, proceedOn?, maxAgeMs?}}
// requireVerdict configures the verdictCheck adapter (src/verdict.ts); its evidence goes in the body as evidence.verdict.

import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { resolve } from 'node:path'
import { Gate } from './gate.ts'
import { isRecord } from './request.ts'
import { verdictCheck } from './verdict.ts'

const MAX_BODY = 64 * 1024

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((res, rej) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { rej(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { res(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { rej(new Error('body is not JSON')) }
    })
    req.on('error', rej)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

export function createGateServer(gate: Gate): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/gate-key') {
        return send(res, 200, { gate_id: gate.gate.id, key_id: gate.keyId, public_key: gate.gate.publicKey })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/decisions/')) {
        const d = gate.decision(decodeURIComponent(url.pathname.slice('/decisions/'.length)))
        return d ? send(res, 200, d) : send(res, 404, { error: 'not_found' })
      }
      if (req.method === 'GET' && url.pathname.startsWith('/reservations/')) {
        const r = gate.reservation(decodeURIComponent(url.pathname.slice('/reservations/'.length)))
        return r ? send(res, 200, { ...r }) : send(res, 404, { error: 'not_found' })
      }
      if (req.method === 'GET' && url.pathname === '/budget') {
        const grantId = url.searchParams.get('grant_id')
        return grantId ? send(res, 200, gate.budget(grantId)) : send(res, 400, { error: 'grant_id is required' })
      }
      if (req.method !== 'POST') return send(res, 404, { error: 'not_found' })
      let body: unknown
      try { body = await readBody(req) } catch (e) { return send(res, 400, { error: (e as Error).message }) }
      if (!isRecord(body)) return send(res, 400, { error: 'body is not a JSON object' })
      if (url.pathname === '/decide') {
        const r = gate.decide(body as never)
        return send(res, 200, { decision: r.record, verdict: r.verdict, reason: r.reason, reservation_id: r.reservation_id, replay: r.replay })
      }
      if (url.pathname === '/outcome') {
        const r = gate.reportOutcome(String(body.reservation_id), body.outcome as never, body.confirmation as never)
        return send(res, r.ok ? 200 : 409, r)
      }
      if (url.pathname === '/reconcile') {
        const r = gate.reconcile(String(body.reservation_id), { outcome: body.outcome as never, confirmation: body.confirmation as never })
        return send(res, r.ok ? 200 : 409, r)
      }
      return send(res, 404, { error: 'not_found' })
    } catch (e) {
      return send(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  })
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: node src/server.ts <config.json>')
    process.exit(2)
  }
  const c = JSON.parse(readFileSync(path, 'utf8'))
  const gate = Gate.open({ dbPath: c.dbPath, gate: c.gate, directory: c.directory, recoveryWindowMs: c.recoveryWindowMs,
    evidenceChecks: c.requireVerdict ? [verdictCheck(c.requireVerdict)] : undefined })
  if (gate.recovered.length > 0) console.log(`startup recovery: ${gate.recovered.length} reservation(s) moved to unresolved`)
  const port = typeof c.port === 'number' ? c.port : 8787
  createGateServer(gate).listen(port, '127.0.0.1', () => console.log(`checkout gate on http://127.0.0.1:${port}`))
}
