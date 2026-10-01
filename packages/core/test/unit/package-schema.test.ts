import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { SCHEMA_PATH } from '../../src/config.ts'

test('runtime schema is packaged locally and equals the public configuration contract', () => {
  const bundled = readFileSync(SCHEMA_PATH, 'utf8')
  const publicContract = readFileSync(new URL('../../../../config/config.schema.json', import.meta.url), 'utf8')
  assert.equal(bundled, publicContract, 'Update both the public contract and the packaged schema together')
  assert.match(SCHEMA_PATH.replaceAll('\\', '/'), /\/packages\/core\/config\/config\.schema\.json$/)
})
