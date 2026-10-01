/**
 * §6.4: probability-driven denial is only honest when the calibration was fitted for the
 * model, template and task that produced the numbers. "A calibration file exists" is not
 * that condition, and these tests are the boundary.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ProviderIdentity, QuestionOutcome } from 'jev-contracts'
import { calibrationApplies, evaluatePolicy, sameDigest } from '../../src/index.ts'

const IDENTITY: ProviderIdentity = {
  kind: 'local', providerVersion: 'v', requestedModel: 'org/weights',
  resolvedModel: 'org/weights#file.gguf',
  modelRevision: 'a'.repeat(40), weightsDigest: 'b'.repeat(64),
  tokenizerRevision: 'c'.repeat(40), templateDigest: 'sha256:tmpl',
  quantization: 'Q4_K_M', synthetic: false,
}

const FITTED = {
  id: 'heldout-2026-09',
  model: {
    requested: 'org/weights', revision: 'a'.repeat(40),
    weightsDigest: `sha256:${'b'.repeat(64)}`, tokenizerRevision: 'c'.repeat(40), quantization: 'Q4_K_M',
  },
  templateDigest: 'sha256:tmpl', task: 'tool-assessment' as const,
}

/**
 * Answers as a provider would return them. `mode` picks which claim about calibration
 * the observation makes, because the whole point is that a config block cannot overrule it.
 */
type AnswerMode = 'fitted' | 'raw' | 'other-id' | 'no-id' | 'no-calibrated-value'

function answers(conflict: number, mode: AnswerMode = 'fitted'): readonly QuestionOutcome[] {
  const probability = {
    origin: 'native-logits' as const,
    calibration: mode === 'raw' ? 'uncalibrated' as const : 'held-out' as const,
    calibrationId: mode === 'other-id' ? 'some-other-fitting'
      : mode === 'no-id' ? null
        : FITTED.id,
  }
  const bool = (id: string, pYes: number): QuestionOutcome => ({
    id, status: 'answered',
    answer: mode === 'no-calibrated-value' || mode === 'raw'
      ? { kind: 'boolean', pYes, probability }
      : { kind: 'boolean', pYes, calibratedPYes: pYes, probability },
  })
  return [bool('advances-goal', 0.9), bool('evidence-sufficient', 0.9), bool('conflicts-with-constraint', conflict)]
}

test('a calibration that names this model, template and task applies', () => {
  assert.deepEqual(calibrationApplies(FITTED, IDENTITY, 'tool-assessment', answers(0.99)), [])
})

test('every identity dimension the declaration names is compared', () => {
  const cases: [string, ProviderIdentity][] = [
    ['calibration-model-requested', { ...IDENTITY, requestedModel: 'org/other' }],
    ['calibration-model-revision', { ...IDENTITY, modelRevision: 'f'.repeat(40) }],
    ['calibration-template-digest', { ...IDENTITY, templateDigest: 'sha256:other' }],
    ['calibration-weightsDigest', { ...IDENTITY, weightsDigest: 'd'.repeat(64) }],
    ['calibration-tokenizerRevision', { ...IDENTITY, tokenizerRevision: 'e'.repeat(40) }],
    ['calibration-quantization', { ...IDENTITY, quantization: 'Q8_0' }],
  ]
  for (const [expected, identity] of cases) {
    const reasons = calibrationApplies(FITTED, identity, 'tool-assessment', answers(0.99))
    assert.ok(reasons.includes(expected), `${expected} missing from ${JSON.stringify(reasons)}`)
  }
})

test('a digest written with and without its prefix names the same bytes', () => {
  assert.equal(sameDigest(`sha256:${'a'.repeat(64)}`, 'a'.repeat(64)), true)
  assert.equal(sameDigest(`SHA256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(64)}`), true)
  assert.equal(sameDigest('a'.repeat(64), 'b'.repeat(64)), false)
})

test('the wrong task may not borrow a calibration fitted for another', () => {
  assert.deepEqual(calibrationApplies(FITTED, IDENTITY, 'tool-relevance', answers(0.99)),
    ['calibration-task:tool-relevance'])
})

test('uncalibrated answers stay uncalibrated however the config is written', () => {
  // This is the hole: a config block must not relabel raw logits as calibrated evidence.
  assert.deepEqual(calibrationApplies(FITTED, IDENTITY, 'tool-assessment', answers(0.99, 'raw')),
    ['calibration-answers-uncalibrated'])
})

test('a claimed calibration must be the one named in the config', () => {
  assert.deepEqual(calibrationApplies(FITTED, IDENTITY, 'tool-assessment', answers(0.99, 'other-id')),
    ['calibration-id-mismatch'])
  assert.deepEqual(calibrationApplies(FITTED, IDENTITY, 'tool-assessment', answers(0.99, 'no-id')),
    ['calibration-id-unreported'])
})

test('thresholds calibrated against P(yes) may not be applied to the raw value', () => {
  // `held-out` with no calibratedPYes means the numbers are raw with a label pasted on.
  assert.deepEqual(
    calibrationApplies(FITTED, IDENTITY, 'tool-assessment', answers(0.99, 'no-calibrated-value')),
    ['calibration-values-missing'])
})

test('without a provider identity nothing is treated as calibrated', () => {
  assert.deepEqual(calibrationApplies(FITTED, null, 'tool-assessment', answers(0.99)), ['provider-identity-unknown'])
})

test('the policy end of the wire: deny needs an applicable calibration', () => {
  const thresholds = { conflictAskAtOrAbove: 0.8, conflictDenyAtOrAbove: 0.9, goalBelow: 0.2, evidenceBelow: 0.2 }
  assert.equal(evaluatePolicy({
    mode: 'enforce', host: { kind: 'allow' }, outcomes: answers(0.99), approvalChannel: true,
    calibrationAvailable: true, thresholds,
  }).action, 'deny')
  // Same numbers, calibration not applicable → escalation at most, never denial.
  const escalated = evaluatePolicy({
    mode: 'enforce', host: { kind: 'allow' }, outcomes: answers(0.99), approvalChannel: true,
    calibrationAvailable: false,
  })
  assert.equal(escalated.action, 'ask')
  assert.deepEqual(escalated.reasonCodes, ['conflict-signal-uncalibrated'])
})
