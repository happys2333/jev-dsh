/**
 * HOST-06: an `ask` decision handed to the real DSH approval service.
 *
 * The previous evidence only proved the *degrade* (no `approval` service composed ⇒ ask
 * becomes a denial). This file composes `@deepseek-ai/dsh-user-approval` itself and shows
 * what a grant does, what a refusal does, and what "nobody answered" does — the three
 * outcomes Jev cannot see in its own return value and must read back from the host's
 * durable audit pair.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import { ApprovalService, type ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { scanJournal, type AuditEvent, type AuditExecution, type Auditable, type LineSink } from 'jev-core'
import { mountJey, type JeyRuntime } from '../../src/jey-plugin.ts'
import { MockProvider } from 'jev-provider-mock'
import { probeTool, probeToolBodyCalls, resetProbeToolBodyCalls } from '../../src/probe-tool.ts'
import { PROBE_LLM_ROUTE, scriptedLlmPlugin } from '../../src/scripted-llm.ts'

/** A terminal answerer: it answers for every request instead of delegating. */
function answererPlugin(outcome: ApprovalOutcome, onAsk?: () => void) {
  return {
    name: 'jey-answerer',
    apply(ctx: Context) {
      ctx.on('approval/request', (_req, next) => {
        void next
        onAsk?.()
        return Promise.resolve(outcome)
      })
    },
  }
}

interface Loop {
  readonly ctx: Context
  readonly agent: Agent
  readonly runtime: JeyRuntime
  readonly lines: string[]
}

async function mountLoop(
  options: { answer?: ApprovalOutcome, session?: string, asks?: () => void, approvalRequests?: boolean } = {},
): Promise<Loop> {
  resetProbeToolBodyCalls()
  const lines: string[] = []
  const audit: LineSink = { writeLine: line => { lines.push(line) } }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(scriptedLlmPlugin)
  ctx.tools.register(probeTool)
  await ctx.plugin(ApprovalService)
  if (options.answer !== undefined) await ctx.plugin(answererPlugin(options.answer, options.asks))
  const raw = config()
  if (options.approvalRequests === false) {
    (raw.features as Record<string, boolean>).approvalRequests = false
  }
  const runtime = mountJey(ctx, raw, { provider: new MockProvider({
    'conflicts-with-constraint': 0.99, 'advances-goal': 0.9, 'evidence-sufficient': 0.9,
  }), audit })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId(options.session ?? 'jey-approval-agent'), {
    provider: PROBE_LLM_ROUTE, model: 'approval-model',
  })
  return { ctx, agent, runtime, lines }
}

/**
 * Enforce with a calibration fitted for another model: the policy may only ask, never
 * deny from raw probabilities. The provider block points at a port nothing listens on,
 * and the answers come from the injected synthetic mock, which the journal labels
 * `synthetic: true` — a test fixture may inject Mock, a user config cannot disguise it.
 */
function config(): Record<string, unknown> {
  return {
    schemaVersion: '1',
    mode: 'enforce',
    provider: {
      kind: 'local',
      local: {
        endpoint: 'http://127.0.0.1:9/v1/decide', tokenRef: 'env:JEY_TEST_TOKEN', ownership: 'external',
        expectedModel: { requested: 'any', revision: 'any' },
      },
    },
    egress: { mode: 'local-only', allowedPurposes: ['tool-assessment'], allowedOrigins: ['http://127.0.0.1:9'] },
    limits: {},
    // Both switches are required: `approvalRequests` is what lets Jev initiate a prompt at
    // all, and the host has to expose the channel. Turning either off degrades to a denial.
    features: { toolAssessment: true, approvalRequests: true },
    audit: {},
    calibration: {
      id: 'fitted-for-something-else',
      appliesTo: {
        model: { requested: 'org/not-this-model', revision: 'f'.repeat(40) },
        templateDigest: 'sha256:not-this-template', task: 'tool-assessment',
      },
      conflictDenyAtOrAbove: 0.9, conflictAskAtOrAbove: 0.8, goalBelow: 0.2, evidenceBelow: 0.2,
    },
  }
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  await new Promise<void>(resolve => {
    const onStatus: Events['agent/status'] = payload => {
      if (payload.agent === agent && payload.status === 'idle') {
        dispose()
        resolve()
      }
    }
    const dispose = ctx.on('agent/status', onStatus)
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
}

function rows(lines: readonly string[]): readonly Auditable[] {
  const scan = scanJournal(`${lines.join('\n')}\n`)
  assert.deepEqual(scan.isolated, [], JSON.stringify(scan.isolated))
  return scan.confirmed
}

function pair(lines: readonly string[]): { decision: AuditEvent, execution: AuditExecution | undefined } {
  const confirmed = rows(lines)
  const found = confirmed.find(r => r.kind === 'decision')
  assert.ok(found !== undefined && found.kind === 'decision', 'expected a decision row')
  const other = confirmed.find(r => r.kind === 'execution')
  return { decision: found, execution: other !== undefined && other.kind === 'execution' ? other : undefined }
}

describe('Jev hands its ask decision to the real approval service', () => {
  it('runs the call when a composed answerer grants it', async () => {
    const loop = await mountLoop({ answer: 'allowed-once' })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(loop.runtime.records.find(r => r.kind === 'decision')?.action, 'ask',
      'a borrowed calibration may only ask')
    assert.equal(probeToolBodyCalls().length, 1, 'a grant is what lets the body run')
    const { decision, execution } = pair(loop.lines)
    assert.ok(execution, 'a granted call must still produce an execution row')
    assert.equal(execution.status, 'succeeded')
    assert.equal(execution.appliedAction, 'ask', 'the row must say Jev asked, not that Jev allowed')
    assert.equal(execution.requestId, decision.requestId)
    assert.equal(decision.hostDecision, 'allow', 'the inner waterfall chain allowed; the approval came after')
    await loop.ctx.fiber.dispose()
  })

  it('records a human refusal as a host denial, not as a tool failure', async () => {
    const loop = await mountLoop({ answer: 'rejected' })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(probeToolBodyCalls().length, 0, 'a refusal never reaches the body')
    const { execution } = pair(loop.lines)
    assert.ok(execution)
    assert.equal(execution.status, 'denied-by-host')
    assert.equal(execution.failureCode, 'approval-rejected',
      'the reason must name the human decision, not a crash')
    await loop.ctx.fiber.dispose()
  })

  it('fails closed through the service when no answerer is composed', async () => {
    // The service is mounted but nobody answers, so the host's own terminal default is
    // `unavailable`. Jev must report that as a denial with its real cause.
    const loop = await mountLoop()
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(probeToolBodyCalls().length, 0)
    const { execution } = pair(loop.lines)
    assert.ok(execution)
    assert.equal(execution.status, 'denied-by-host')
    assert.equal(execution.failureCode, 'approval-unavailable')
    await loop.ctx.fiber.dispose()
  })

  it('refuses to load a deployment that wants approvals on a host without a channel', async () => {
    // HOST-14's unsupported-combination half: declaring the feature without the host seam is
    // a configuration error, not something to discover when the first prompt is due.
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await assert.rejects(
      async () => { mountJey(ctx, config(), { provider: new MockProvider(), audit: { writeLine: () => { } } }) },
      (e: unknown) => e instanceof Error && /APPROVAL_WITHOUT_HOST_CHANNEL/.test(e.message),
    )
    await ctx.fiber.dispose()
  })

  it('degrades the question to a recorded denial when no channel can surface it', async () => {
    // With the feature off there is nobody to ask, and the restriction is the same one the
    // host would have applied. What changes is the record: it names the absent channel
    // instead of leaving the reader to infer it from a service that is not there.
    const loop = await mountLoopNoService(false)
    await runTurn(loop.ctx, loop.agent, 'note this down')

    const { decision, execution } = pair(loop.lines)
    assert.equal(decision.action, 'deny')
    assert.ok(decision.reasonCodes.includes('conflict-signal-uncalibrated'),
      'the original cause is still recorded')
    assert.ok(decision.reasonCodes.includes('approval-channel-absent'), JSON.stringify(decision.reasonCodes))
    assert.ok(!decision.reasonCodes.includes('probability:conflict'),
      'an uncalibrated signal must not become a denial on the merits')
    assert.equal(probeToolBodyCalls().length, 0)
    assert.ok(execution, 'a refusal now gets its own row instead of being implied by absence')
    assert.equal(execution.status, 'not-dispatched')
    assert.equal(execution.failureCode, 'approval-channel-absent')
    await loop.ctx.fiber.dispose()
  })

  it('opens exactly one approval question per decision', async () => {
    // Jev hands the ask to the host rather than running a prompt of its own, so a second
    // question for the same call would mean two channels deciding the same thing.
    let asks = 0
    const loop = await mountLoop({ answer: 'allowed-once', asks: () => { asks += 1 } })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(asks, 1, `approval questions: ${asks}`)
    assert.equal(probeToolBodyCalls().length, 1)
    await loop.ctx.fiber.dispose()
  })

  it('does not prompt when approval requests are switched off, even on a capable host', async () => {
    // `features.approvalRequests` used to be checked only at load, so a deployment that left
    // it off still interrupted the operator whenever the host had an approval service.
    let asks = 0
    const loop = await mountLoop({ answer: 'allowed-once', asks: () => { asks += 1 }, approvalRequests: false })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(asks, 0, 'the switch has to mean no prompt, not only a valid config')
    assert.equal(probeToolBodyCalls().length, 0, 'the escalation degrades to a denial instead')
    const { decision, execution } = pair(loop.lines)
    assert.equal(decision.action, 'deny')
    assert.ok(decision.reasonCodes.includes('approval-channel-absent'), JSON.stringify(decision.reasonCodes))
    assert.ok(execution)
    assert.equal(execution.status, 'not-dispatched')
    await loop.ctx.fiber.dispose()
  })
})

/** The same mount without the approval service, to prove the channel is what changed. */
async function mountLoopNoService(approvalRequests = true): Promise<Loop> {
  resetProbeToolBodyCalls()
  const lines: string[] = []
  const audit: LineSink = { writeLine: line => { lines.push(line) } }
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(scriptedLlmPlugin)
  ctx.tools.register(probeTool)
  const raw = config()
  if (!approvalRequests) (raw.features as Record<string, boolean>).approvalRequests = false
  const runtime = mountJey(ctx, raw, { provider: new MockProvider({
    'conflicts-with-constraint': 0.99, 'advances-goal': 0.9, 'evidence-sufficient': 0.9,
  }), audit })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('jey-approval-nosvc'), { provider: PROBE_LLM_ROUTE, model: 'approval-model' })
  return { ctx, agent, runtime, lines }
}
