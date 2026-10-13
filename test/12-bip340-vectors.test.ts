// The verifier against the official BIP-340 test vectors.
// Source: bitcoin/bips at 200f9b26fe0a2f235a2af8b30c4be9f12f6bc9cb, bip-0340/test-vectors.csv,
// sha256 34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d (checked below).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { schnorrVerify } from '../src/verdict.ts'

const raw = readFileSync(new URL('./vectors/bip340-test-vectors.csv', import.meta.url))
const rows = raw.toString('utf8').trim().split('\n').slice(1).map(l => {
  const [index, , pubkey, , message, signature, result] = l.split(',')
  return { index, pubkey, message, signature, expected: result === 'TRUE' }
})

test('12. the vector file is the pinned one', () => {
  assert.equal(createHash('sha256').update(raw).digest('hex'), '34c9d1d9c3a88d524bc80778540dc43f8306ec249a7485293063c376db851c2d')
  assert.equal(rows.length, 19)
})

test('12. every official vector with a 32-byte message gives the expected result (15, valid and invalid)', () => {
  const v32 = rows.filter(r => r.message.length === 64)
  assert.equal(v32.length, 15)
  assert.ok(v32.some(r => r.expected) && v32.some(r => !r.expected))
  for (const r of v32) {
    const got = schnorrVerify(Buffer.from(r.message, 'hex'), Buffer.from(r.pubkey, 'hex'), Buffer.from(r.signature, 'hex'))
    assert.equal(got, r.expected, `vector ${r.index}`)
  }
})

test('12. a message that is not 32 bytes is refused, even where BIP-340 says the signature is valid', () => {
  // NIP-01 signs the 32-byte event id, so the verifier only accepts 32-byte messages (vectors 15-18: 0, 1, 17, 100 bytes).
  const other = rows.filter(r => r.message.length !== 64)
  assert.equal(other.length, 4)
  for (const r of other) {
    assert.equal(schnorrVerify(Buffer.from(r.message, 'hex'), Buffer.from(r.pubkey, 'hex'), Buffer.from(r.signature, 'hex')), false, `vector ${r.index}`)
  }
})
