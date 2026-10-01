import test from 'node:test'
import assert from 'node:assert/strict'
import { jevPlugin, mountJev, jeyPlugin, mountJey } from '../../src/jev-plugin.ts'
import { jeyPlugin as legacyEntry } from '../../src/jey-plugin.ts'
import { combineHostAndJev, combineHostAndJey } from 'jev-core'

test('corrected Jev names preserve the previous entry and behavior', () => {
  assert.equal(jevPlugin.name, 'jev')
  assert.equal(jevPlugin, jeyPlugin)
  assert.equal(jevPlugin, legacyEntry)
  assert.equal(mountJev, mountJey)
  assert.equal(combineHostAndJev, combineHostAndJey)
})
