import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'
import type { DecisionAction, HostDecision } from 'jev-contracts'
import { combineHostAndJey } from '../../src/policy.ts'

test('POL-02 repeated action merge is idempotent including exact reasons', () => {
  const host = fc.oneof(
    fc.constant<HostDecision>({kind: 'allow'}),
    fc.constant<HostDecision>({kind: 'cancel'}),
    fc.string().map(reason => ({kind: 'deny' as const, reason})),
    fc.option(fc.string(), {nil: undefined}).map(reason => reason === undefined
      ? {kind: 'ask' as const} : {kind: 'ask' as const, reason}),
  )
  fc.assert(fc.property(host, fc.constantFrom<DecisionAction>('abstain', 'ask', 'deny', 'cancel'), (original, action) => {
    const once = combineHostAndJey(original, action)
    assert.deepEqual(combineHostAndJey(once, action), once)
  }), {numRuns: 1000, seed: 20260930})
})
