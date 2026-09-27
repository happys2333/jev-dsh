import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_PROGRESS_CONFIG,
  EMPTY_PROGRESS,
  fingerprintOf,
  isPathPaused,
  observeCall,
  type CallObservation,
  type ProgressStore,
} from '../../src/index.ts'

function obs(overrides: Partial<CallObservation> = {}): CallObservation {
  return {
    scopeKey: 'session-1',
    toolName: 'deploy',
    normalizedArguments: { target: 'staging' },
    status: 'failure',
    deterministicError: 'EACCES',
    resourceVersions: {},
    rootCallId: null,
    isPoll: false,
    observationSequence: 1,
    ...overrides,
  }
}

function run(observations: CallObservation[], config = DEFAULT_PROGRESS_CONFIG): { store: ProgressStore; kinds: string[] } {
  let store: ProgressStore = EMPTY_PROGRESS
  const kinds: string[] = []
  for (const o of observations) {
    const r = observeCall(store, o, config)
    store = r.store
    kinds.push(r.outcome.kind)
  }
  return { store, kinds }
}

const repeated = (n: number, overrides: Partial<CallObservation> = {}) =>
  Array.from({ length: n }, (_, i) => obs({ observationSequence: i + 1, ...overrides }))

test('repeating the exact same failure pauses the path at the limit', () => {
  const { store, kinds } = run(repeated(3))
  assert.deepEqual(kinds, ['repeat-failure', 'repeat-failure', 'path-paused'])
  assert.equal(Object.values(store)[0]?.count, 3)
  assert.equal(isPathPaused(store, obs()), true)
})

test('a paused path stays paused instead of getting a fresh failure budget', () => {
  const { store, kinds } = run(repeated(6))
  assert.deepEqual(kinds, ['repeat-failure', 'repeat-failure', 'path-paused', 'path-paused', 'path-paused', 'path-paused'])
  assert.equal(Object.values(store)[0]?.count, 3)
  assert.equal(isPathPaused(store, obs()), true)
})

test('a changed fingerprint unpause the path for new work', () => {
  const { store, kinds } = run([...repeated(3), obs({ deterministicError: 'ENOTFOUND', observationSequence: 4 })])
  assert.equal(kinds[3], 'repeat-failure')
  assert.equal(isPathPaused(store, obs({ deterministicError: 'ENOTFOUND', observationSequence: 5 })), false)
})

test('the limit is configurable and does not hard-ban the agent', () => {
  const { kinds } = run(repeated(2), { ...DEFAULT_PROGRESS_CONFIG, maxIdenticalFailures: 2 })
  assert.deepEqual(kinds, ['repeat-failure', 'path-paused'])
})

test('a changed argument opens a new path instead of resuming the paused one', () => {
  const { store, kinds } = run([
    obs({ observationSequence: 1 }),
    obs({ observationSequence: 2 }),
    obs({ normalizedArguments: { target: 'prod' }, observationSequence: 3 }),
  ])
  assert.deepEqual(kinds, ['repeat-failure', 'repeat-failure', 'repeat-failure'])
  const counts = Object.values(store).map(s => s.count).sort()
  assert.deepEqual(counts, [1, 2], 'the second argument set is its own path')
})

test('a different deterministic error resets the counter', () => {
  const { kinds } = run([
    obs({ observationSequence: 1 }),
    obs({ observationSequence: 2 }),
    obs({ deterministicError: 'ETIMEOUT', observationSequence: 3 }),
  ])
  assert.deepEqual(kinds.slice(2), ['repeat-failure'])
})

test('an observed resource change resets the counter', () => {
  const { kinds } = run([
    obs({ observationSequence: 1 }),
    obs({ observationSequence: 2 }),
    obs({ resourceVersions: { 'file:a.txt': 'v2' }, observationSequence: 3 }),
  ])
  assert.equal(kinds[2], 'repeat-failure')
})

test('a success clears the path entirely', () => {
  const { store, kinds } = run([...repeated(2), obs({ status: 'success', observationSequence: 3 })])
  assert.equal(kinds[2], 'progress')
  assert.deepEqual(store, {})
})

test('status polling has its own budget and is not called stuck', () => {
  const polls = repeated(5, { isPoll: true, deterministicError: null })
  const { kinds } = run(polls, { maxIdenticalFailures: 3, pollBudget: 3 })
  assert.deepEqual(kinds, ['progress', 'progress', 'progress', 'poll-budget-exhausted', 'poll-budget-exhausted'])
})

test('a poll sequence does not feed the identical-failure counter', () => {
  const polls = [1, 2].map(sequence => obs({ isPoll: true, deterministicError: null, observationSequence: sequence }))
  const failures = [3, 4].map(sequence => obs({ observationSequence: sequence }))
  const { store } = run([...polls, ...failures])
  const state = Object.values(store)[0]
  assert.equal(state?.count, 2)
  assert.equal(state?.polls, 2)
  assert.equal(state?.paused, false)
})

test('one attempt is counted once, not once per nested dispatch', () => {
  // A parent result and its PTC children share the host-resolved rootCallId. Counting
  // each of them would reach the failure limit inside a single turn.
  const parent = obs({ rootCallId: 'root-1', observationSequence: 1 })
  const child = obs({ toolName: 'inner', normalizedArguments: { a: 1 }, rootCallId: 'root-1', observationSequence: 2 })
  const replay = obs({ rootCallId: 'root-1', observationSequence: 3 })
  const { store, kinds } = run([parent, child, replay])
  assert.deepEqual(kinds, ['repeat-failure', 'repeat-failure', 'ignored-duplicate'])
  assert.deepEqual(Object.values(store).map(s => s.count).sort(), [1, 1],
    'a replayed attempt must not inflate any path')
})

test('a pause survives across fresh root call ids', () => {
  // The host mints a new rootCallId per model-requested call. If the path were keyed by
  // it, three identical failures in three turns would each start at count 1 and the
  // pause would be unreachable in real use.
  const { store, kinds } = run([
    obs({ rootCallId: 'call-1', observationSequence: 1 }),
    obs({ rootCallId: 'call-2', observationSequence: 2 }),
    obs({ rootCallId: 'call-3', observationSequence: 3 }),
  ])
  assert.deepEqual(kinds, ['repeat-failure', 'repeat-failure', 'path-paused'])
  assert.equal(isPathPaused(store, { scopeKey: 'session-1', toolName: 'deploy', normalizedArguments: { target: 'staging' } }), true)
})

test('two scopes repeating the same call do not share a counter', () => {
  const { store, kinds } = run([
    obs({ scopeKey: 'session-A', observationSequence: 1 }),
    obs({ scopeKey: 'session-A', observationSequence: 2 }),
    obs({ scopeKey: 'session-B', observationSequence: 3 }),
  ])
  assert.deepEqual(kinds, ['repeat-failure', 'repeat-failure', 'repeat-failure'])
  assert.equal(Object.values(store).every(s => s.count < 3), true, 'session B must not inherit A twice-failed path')
})

test('a replayed result with a non-advancing sequence is ignored', () => {
  const { kinds } = run([obs({ observationSequence: 5 }), obs({ observationSequence: 5 })])
  assert.deepEqual(kinds, ['repeat-failure', 'ignored-duplicate'])
})

test('fingerprint is stable for equal facts and differs when facts differ', () => {
  assert.equal(fingerprintOf(obs()), fingerprintOf(obs()))
  assert.notEqual(fingerprintOf(obs()), fingerprintOf(obs({ deterministicError: 'ENOTFOUND' })))
  assert.notEqual(fingerprintOf(obs()), fingerprintOf(obs({ resourceVersions: { a: '1' } })))
})
