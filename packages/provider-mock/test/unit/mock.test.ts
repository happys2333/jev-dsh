/**
 * The mock is the one provider that must never be mistaken for evidence. Its own honesty
 * rules — always synthetic, never claims egress, answers every question kind it advertises —
 * are what both adapters' gates rest on, so they are tested here rather than assumed.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DecisionRequest, Question } from 'jey-contracts'
import { MockProvider } from '../../src/index.ts'

const SNAPSHOT = {
  sessionId: 's', agentId: 'a', turn: 1, step: 1, generation: 1, taskVersion: 1,
  policyVersion: 'p', catalogDigest: 'sha256:c', callDigest: null, observationSequence: 1,
} as const

function request(questions: readonly Question[]): DecisionRequest {
  return {
    schemaVersion: '1', requestId: 'req_test', purpose: 'evidence-check', snapshot: SNAPSHOT,
    state: { any: 'value' }, questions, budget: { maxElapsedMs: 1000, maxInputBytes: 4096 },
  }
}

describe('mock provider honesty', () => {
  it('announces itself as synthetic whatever the caller asks it to report', async () => {
    const provider = new MockProvider({}, 'answer', { identity: { kind: 'local', resolvedModel: 'llama-3', synthetic: false } })
    const answered = await provider.evaluate(request([{ kind: 'boolean', id: 'q', instructions: 'i' }]), { signal: new AbortController().signal })
    assert.equal(answered.provider.synthetic, true, 'a mock that could report synthetic:false is not a mock')
    assert.equal(answered.provider.kind, 'mock', 'the reported kind is not overridable either')
    const capabilities = await provider.capabilities()
    assert.equal(capabilities.provider.synthetic, true)
  })

  it('says it sent nothing anywhere', async () => {
    const answered = await new MockProvider().evaluate(
      request([{ kind: 'boolean', id: 'q', instructions: 'i' }]), { signal: new AbortController().signal })
    assert.deepEqual(answered.egress, { occurred: false, destinationId: null })
    assert.equal(answered.usage.costBasis, 'unknown', 'a synthetic answer has no cost to report')
  })

  it('answers each question kind it advertises, in that kind', async () => {
    const provider = new MockProvider({ b: 0.9, c: 0.9, s: 0.9 })
    const answered = await provider.evaluate(request([
      { kind: 'boolean', id: 'b', instructions: 'i' },
      { kind: 'choice', id: 'c', instructions: 'i', options: [{ id: 'x', description: 'x' }, { id: 'y', description: 'y' }] },
      { kind: 'score', id: 's', instructions: 'i', levels: ['none applicable', 'poor', 'fair', 'good', 'strong'] },
    ]), { signal: new AbortController().signal })
    const kinds = answered.outcomes.map(o => o.status === 'answered' ? o.answer.kind : o.status)
    assert.deepEqual(kinds, ['boolean', 'choice', 'score'])
    const choice = answered.outcomes[1]
    const score = answered.outcomes[2]
    if (choice?.status !== 'answered' || choice.answer.kind !== 'choice') throw new Error('no choice answer')
    if (score?.status !== 'answered' || score.answer.kind !== 'score') throw new Error('no score answer')
    // The distribution has to sum, or every gate that reads a probability is reading noise.
    assert.ok(Math.abs(Object.values(choice.answer.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9)
    assert.ok(Math.abs(Object.values(score.answer.probabilities).reduce((a, b) => a + b, 0) - 1) < 1e-9)
    assert.equal(choice.answer.selected, 'y', 'a high score picks the late option')
    assert.ok(score.answer.expectedIndex >= 0 && score.answer.expectedIndex <= 4)
  })

  it('reports an abstention as an abstention, not as a low number', async () => {
    const answered = await new MockProvider({ q: 0.9 }, 'abstain').evaluate(
      request([{ kind: 'boolean', id: 'q', instructions: 'i' }]), { signal: new AbortController().signal })
    assert.deepEqual(answered.outcomes, [{ id: 'q', status: 'abstained', reason: 'unsupported' }])
  })

  it('claims a calibration only when one was configured', async () => {
    const plain = await new MockProvider({ q: 0.7 }).evaluate(
      request([{ kind: 'boolean', id: 'q', instructions: 'i' }]), { signal: new AbortController().signal })
    const first = plain.outcomes[0]
    assert.ok(first?.status === 'answered')
    assert.equal(first.answer.probability.calibration, 'uncalibrated')
    assert.equal(first.answer.probability.calibrationId, null)

    const calibrated = await new MockProvider({ q: 0.7 }, 'answer', { calibrationId: 'cal-2026-09' }).evaluate(
      request([{ kind: 'boolean', id: 'q', instructions: 'i' }]), { signal: new AbortController().signal })
    const second = calibrated.outcomes[0]
    assert.ok(second?.status === 'answered')
    assert.equal(second.answer.probability.calibration, 'held-out')
    assert.equal(second.answer.probability.calibrationId, 'cal-2026-09')
  })
})
