/**
 * The read-only doctor (spec §11). These are unit tests of `buildDoctorReport`: the host
 * observation and the journal arrive as inputs, so nothing here boots DSH or reaches a
 * socket. What is enforced is the promise the command exists to keep — say what was
 * observed, say plainly what was not, and never leak a credential.
 *
 * @module
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ProviderCapabilities } from 'jey-contracts'
import { buildDoctorReport, PINNED_LAUNCHER, type DoctorInput, type HostObservation, type ProviderProbe } from '../../src/doctor.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))
const example = (name: string): unknown => JSON.parse(readFileSync(`${repoRoot}config/examples/${name}`, 'utf8')) as unknown

const pinned: HostObservation = { launcherVersion: PINNED_LAUNCHER, approvalComposed: true, source: 'test' }
const noJournal: ProviderProbe = { attempted: false, reason: 'not attempted in this test' }

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    raw: example('off-minimal.json'),
    host: pinned,
    journalText: '{"kind":"diagnostic","auditId":"aud_1","requestId":"","sessionId":"","at":1,"reason":"mounted:mode=off provider=unconfigured egress=deny"}\n',
    probe: noJournal,
    ...overrides,
  }
}

test('doctor: a config the loader refuses is reported as REFUSED with its codes', () => {
  const report = buildDoctorReport(input({ raw: { schemaVersion: '1', mode: 'enforce', provider: { kind: 'mock' }, egress: { mode: 'deny' }, limits: {}, features: {}, audit: {} } }))
  assert.equal(report.verdict, 'REFUSED')
  assert.equal(report.config.accepted, false)
  assert.ok(report.config.errors.some(e => e.startsWith('ENFORCE_WITH_MOCK@')), JSON.stringify(report.config.errors))
  assert.ok(report.reasons.some(r => r.startsWith('config-refused:')))
})

test('doctor: an unobserved launcher is never reported as compatible', () => {
  const mismatch = buildDoctorReport(input({ host: { ...pinned, launcherVersion: '0.1.5-rc.2' } }))
  assert.equal(mismatch.compatibility.verdict, 'MISMATCH')
  assert.equal(mismatch.verdict, 'NOT_READY')
  assert.ok(mismatch.reasons.some(r => r === `launcher-mismatch:0.1.5-rc.2!=${PINNED_LAUNCHER}`), JSON.stringify(mismatch.reasons))

  const unknown = buildDoctorReport(input({ host: { ...pinned, launcherVersion: null } }))
  assert.equal(unknown.compatibility.verdict, 'UNKNOWN')
  // Unobserved is not the same as incompatible: the report must not claim a match either.
  assert.notEqual(unknown.compatibility.verdict, 'MATCH')
})

test('doctor: a journal without a mount row means Jey is not proven to be running', () => {
  const noMount = buildDoctorReport(input({
    journalText: '{"kind":"diagnostic","auditId":"aud_1","requestId":"","sessionId":"","at":1,"reason":"dropped-late"}\n',
  }))
  assert.equal(noMount.journal.mounted, false)
  assert.equal(noMount.verdict, 'NOT_READY')
  assert.ok(noMount.reasons.some(r => r.startsWith('journal-unmounted:')))

  const absent = buildDoctorReport(input({ journalText: null }))
  assert.equal(absent.journal.present, false)
  assert.ok(absent.reasons.some(r => r.startsWith('journal-absent:')))
})

test('doctor: mock answers are labelled synthetic and never probed', () => {
  const report = buildDoctorReport(input({
    raw: { schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' }, egress: { mode: 'deny' }, limits: {}, features: {}, audit: {} },
    journalText: '{"kind":"diagnostic","auditId":"aud_1","requestId":"","sessionId":"","at":1,"reason":"mounted:mode=shadow provider=mock egress=deny"}\n',
  }))
  assert.equal(report.provider.inference.startsWith('SYNTHETIC'), true, report.provider.inference)
  assert.equal(report.provider.probed, false)
})

test('doctor: a cloud provider is reported as NOT_RUN, and no request is made', async () => {
  const realFetch = globalThis.fetch
  let outbound = 0
  globalThis.fetch = (async () => { outbound += 1; throw new Error('doctor must not reach the network') }) as unknown as typeof globalThis.fetch
  try {
    process.env.JEY_DOCTOR_TEST_KEY = 'a-value-doctor-must-print-nothing-of'
    const report = buildDoctorReport(input({
      raw: {
        schemaVersion: '1', mode: 'shadow',
        provider: { kind: 'typesafe', typesafe: { credentialRef: 'env:JEY_DOCTOR_TEST_KEY', model: 'jev-latest', endpointOrigin: 'https://api.typesafe.ai' } },
        egress: { mode: 'allowlist', allowedPurposes: ['tool-assessment'], allowedOrigins: ['https://api.typesafe.ai'] },
        limits: {}, features: {}, audit: {},
      },
      probe: { attempted: false, reason: 'NOT_RUN：云端能力探测需要真实调用授权，doctor 不发请求' },
      journalText: '{"kind":"diagnostic","auditId":"aud_1","requestId":"","sessionId":"","at":1,"reason":"mounted:mode=shadow provider=typesafe egress=allowlist"}\n',
    }))
    assert.equal(report.provider.probed, false)
    assert.ok(report.provider.reason.includes('NOT_RUN'), report.provider.reason)
    assert.equal(outbound, 0)
    // Spec §11: credentials appear only as configured/not, and never as their value.
    assert.deepEqual(report.credentials, [{ reference: 'env:JEY_DOCTOR_TEST_KEY', configured: true }])
    assert.ok(!JSON.stringify(report).includes('a-value-doctor-must-print-nothing-of'), 'the credential value leaked into the report')
  } finally {
    globalThis.fetch = realFetch
    delete process.env.JEY_DOCTOR_TEST_KEY
  }
})

test('doctor: a probe that succeeded reports what the service said about itself', () => {
  const capabilities: ProviderCapabilities = {
    provider: {
      kind: 'local', providerVersion: '0.3.0', requestedModel: 'Qwen3.5-4B', resolvedModel: 'Qwen_Qwen3.5-4B-Q4_K_M.gguf',
      modelRevision: '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a', weightsDigest: 'sha256:13c16f426047e2de38cd075bdade4a7b',
      tokenizerRevision: null, quantization: 'Q4_K_M', templateDigest: 'sha256:t', synthetic: false,
    },
    questionKinds: ['boolean'], maxInputBytes: 32768, maxQuestions: 8, cancellation: 'discard-only',
  }
  const report = buildDoctorReport(input({ probe: { attempted: true, ok: true, capabilities } }))
  assert.equal(report.provider.probed, true)
  assert.ok(report.provider.identity !== null)
  assert.ok(report.provider.identity.includes('851bf6e806ef'), report.provider.identity)
  assert.ok(!report.provider.identity.startsWith('SYNTHETIC'), 'a real service must not be labelled synthetic')
})

test('doctor: a probe that failed is NOT_READY and keeps the reason visible', () => {
  const report = buildDoctorReport(input({
    raw: example('local-enforce.json'),
    journalText: '{"kind":"diagnostic","auditId":"aud_1","requestId":"","sessionId":"","at":1,"reason":"mounted:mode=enforce provider=local egress=local-only"}\n',
    probe: { attempted: true, ok: false, error: 'connect refused' },
  }))
  assert.equal(report.config.accepted, true, JSON.stringify(report.config.errors))
  assert.equal(report.verdict, 'NOT_READY')
  assert.ok(report.reasons.some(r => r === 'provider-unreachable:connect refused'), JSON.stringify(report.reasons))
  assert.equal(report.provider.inference.startsWith('UNAVAILABLE'), true, report.provider.inference)
})

test('doctor: counters and isolated lines come from the journal as written', () => {
  const decision = (action: string, requestId: string, codes: string) =>
    `{"kind":"decision","auditId":"aud_${requestId}","requestId":"${requestId}","sessionId":"s","agentId":"a","providerKind":"mock","synthetic":true,`
    + `"resolvedModel":"m","templateDigest":"sha256:t","snapshot":{"sessionId":"s","agentId":"a","turn":1,"step":1,"callDigest":null,"catalogDigest":"sha256:c","taskVersion":1},`
    + `"timing":{"queueMs":0,"inferenceMs":0,"totalMs":0},"questionStatuses":[],"action":"${action}","reasonCodes":${codes},"hostDecision":"allow","execution":null,`
    + `"failureCode":null,"egressOccurred":false,"stale":false,"truncatedPaths":[],"at":2}`
  const execution = (requestId: string, status: string) =>
    `{"kind":"execution","auditId":"aud_x_${requestId}","requestId":"${requestId}","sessionId":"s","agentId":"a","toolName":"t","status":"${status}",`
    + `"hostDecision":"allow","appliedAction":"abstain","failureCode":null,"at":3}`
  const report = buildDoctorReport(input({
    journalText: [
      '{"kind":"diagnostic","auditId":"aud_0","requestId":"","sessionId":"","at":1,"reason":"mounted:mode=shadow provider=mock egress=deny"}',
      decision('abstain', 'r1', '["no-jey-restriction"]'),
      execution('r1', 'succeeded'),
      decision('deny', 'r2', '["hard-rule-conflict","hard-rule:path-paused"]'),
      execution('r2', 'not-dispatched'),
      'not json at all',
    ].join('\n') + '\n',
  }))
  assert.equal(report.journal.decisions, 2)
  assert.deepEqual(report.journal.actions, { abstain: 1, deny: 1 })
  assert.deepEqual(report.journal.executions, { succeeded: 1, 'not-dispatched': 1 })
  assert.equal(report.journal.isolated, 1)
  assert.deepEqual(report.journal.lastErrors, ['deny:hard-rule-conflict', 'deny:hard-rule:path-paused'])
})
