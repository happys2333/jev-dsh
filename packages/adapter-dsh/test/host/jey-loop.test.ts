/**
 * M2 closed loop: Jev's decision core driving a real DSH agent loop and a real
 * ToolRuntime, with only the model replaced by a scripted adapter and the decision
 * provider replaced by the synthetic mock. Nothing here stubs the host pipeline.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Events } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ConfigError, scanJournal, type AuditEvent, type LineSink } from 'jev-core'
import { mountJey, type JeyRuntime } from '../../src/jey-plugin.ts'
import { MockProvider } from 'jev-provider-mock'
import {
  PROBE_TOOL_NAME, probeTool, probeToolBodyCalls, resetProbeToolBodyCalls, setProbeToolFailure,
} from '../../src/probe-tool.ts'
import {
  PROBE_LLM_ROUTE, REPEAT_LLM_ROUTE, repeatingProbeLlmPlugin, scriptedLlmPlugin,
} from '../../src/scripted-llm.ts'

function jeyConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: '1',
    mode: 'shadow',
    provider: { kind: 'mock' },
    egress: { mode: 'deny' },
    limits: {},
    // Explicit: the schema default is false, and every test in this file is about the
    // assessment path actually running. They used to pass without it only because the
    // feature check could never be true.
    features: { toolAssessment: true },
    audit: {},
    ...overrides,
  }
}

interface Loop {
  readonly ctx: Context
  readonly agent: Agent
  readonly agents: readonly Agent[]
  readonly runtime: JeyRuntime
  readonly provider: MockProvider
  readonly lines: string[]
}

interface LoopOptions {
  /** Ask for the probe tool on every step instead of exactly once. */
  readonly repeat?: boolean
  /** Make the tool body record the call and then fail. */
  readonly failTool?: boolean
  /** Session ids to create; the first one is returned as `agent` too. */
  readonly sessions?: readonly string[]
  /** Replace the injected provider, e.g. to control the identity it reports. */
  readonly provider?: MockProvider
  /** Make every audit write fail, to exercise the fail-closed setting. */
  readonly failAudit?: boolean
}

async function mountLoop(
  config: Record<string, unknown>,
  answers?: Record<string, number>,
  options: LoopOptions = {},
): Promise<Loop> {
  resetProbeToolBodyCalls()
  setProbeToolFailure(options.failTool === true)
  const lines: string[] = []
  const audit: LineSink = options.failAudit === true
    ? { writeLine: () => { throw new Error('simulated unavailable audit storage') } }
    : { writeLine: line => { lines.push(line) } }
  const provider = options.provider ?? new MockProvider(answers)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const plugin = options.repeat === true ? repeatingProbeLlmPlugin : scriptedLlmPlugin
  const route = options.repeat === true ? REPEAT_LLM_ROUTE : PROBE_LLM_ROUTE
  await ctx.plugin(plugin)
  ctx.tools.register(probeTool)
  const runtime = mountJey(ctx, config, { provider, audit })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agents: Agent[] = []
  for (const session of options.sessions ?? ['jey-loop-agent']) {
    agents.push(await harness.create(SessionId(session), { provider: route, model: 'loop-model' }))
  }
  return { ctx, agent: agents[0] as Agent, agents, runtime, provider, lines }
}

function nextIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise(resolve => {
    const onStatus: Events['agent/status'] = payload => {
      if (payload.agent === agent && payload.status === 'idle') {
        disposeStatus()
        resolve()
      }
    }
    const disposeStatus = ctx.on('agent/status', onStatus)
  })
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  const settled = nextIdle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  await settled
}

/**
 * Admit a real `agent/pre-step` for the loop's agent while a decision is open — the same
 * dispatch the loop itself performs, so a freshness check is being beaten by host activity
 * rather than by a test inventing state.
 */
async function admitStep(loop: Loop, text: string): Promise<void> {
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  await loop.ctx.waterfall('agent/pre-step', {
    agent: loop.agent, messages: [message], turn: 2, step: 5, signal: new AbortController().signal,
  }, async () => ({ kind: 'enter' as const, messages: [message] }))
}

function decisions(runtime: JeyRuntime): readonly AuditEvent[] {
  return runtime.records.filter(r => r.kind === 'decision')
}

/**
 * A local provider block pointed at a port nothing listens on. Nothing here ever opens a
 * socket: the assertion in these tests is about what Jev decides *before* dispatch, so a
 * refusal must be provable without a reachable service.
 */
function localProviderBlock(model?: { requested: string, revision: string }): Record<string, unknown> {
  return {
    endpoint: 'http://127.0.0.1:9', tokenRef: 'env:JEY_TEST_TOKEN', ownership: 'external',
    expectedModel: model ?? { requested: 'any', revision: 'any' },
  }
}

function localEgress(): Record<string, unknown> {
  return {
    mode: 'local-only', allowedOrigins: ['http://127.0.0.1:9'], allowedPurposes: ['tool-assessment'],
  }
}

describe('Jev closed loop on a real DSH agent', () => {
  it('observes a tool call in shadow without changing what the host decided', async () => {
    const loop = await mountLoop(jeyConfig())
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.deepEqual(probeToolBodyCalls().length, 1, 'shadow must not stop the call')
    assert.equal(loop.provider.calls, 1, 'the provider was consulted')

    const [record] = decisions(loop.runtime)

    assert.ok(record, 'expected one decision record')
    assert.equal(record.action, 'abstain')
    assert.equal(record.hostDecision, 'allow')
    assert.equal(record.synthetic, true, 'a mock answer is always labelled synthetic')
    assert.equal(record.egressOccurred, false)
    assert.equal(record.snapshot.taskVersion, 1, 'the user message reached the task state')
    const written = scanJournal(`${loop.lines.join('\n')}\n`)
    assert.deepEqual(written.isolated, [])
    // The mount row, then one decision row, then the execution row that follows it: the
    // decision alone cannot say whether the call worked, which is why the third exists.
    assert.deepEqual(written.confirmed.map(r => r.kind), ['diagnostic', 'decision', 'execution'])
    assert.equal((written.confirmed[0] as { reason: string }).reason, 'mounted:mode=shadow provider=mock egress=deny')
    const execution = written.confirmed.find(r => r.kind === 'execution')
    if (execution?.kind === 'execution') {
      assert.equal(execution.status, 'succeeded')
      assert.equal(execution.requestId, record.requestId, 'the two rows must correlate')
      assert.equal(execution.toolName, PROBE_TOOL_NAME)
    }
    loop.runtime.close()
  })

  it('keeps a later listener’s denial ahead of what Jev decides', async () => {
    // The monotone table in core is only half the guarantee: the adapter reads the host's
    // decision through `fromPreTool`, and a dropped `deny` branch there would quietly hand
    // the host's own refusal back as an allow. Nothing in core can see that.
    const loop = await mountLoop(jeyConfig())
    loop.ctx.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'later-policy-denied' }))
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(probeToolBodyCalls().length, 0, 'a refusal from the chain must survive Jev')
    const [record] = decisions(loop.runtime)
    assert.equal(record?.hostDecision, 'deny', 'the row must record the refusal as the host decision')
    assert.equal(record?.action, 'abstain', 'shadow itself added no restriction')
    loop.runtime.close()
  })

  it('does not consult anything at all while off', async () => {
    const loop = await mountLoop(jeyConfig({ mode: 'off' }))
    await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.equal(loop.provider.calls, 0)
    assert.deepEqual(decisions(loop.runtime), [])
    // The mount row is the only thing in the journal: off mode records no per-call
    // decision, which is the point of the mode.
    const written = scanJournal(`${loop.lines.join('\n')}\n`)
    assert.deepEqual(written.isolated, [])
    assert.deepEqual(written.confirmed.map(r => r.kind), ['diagnostic'])
    assert.equal((written.confirmed[0] as { reason: string }).reason, 'mounted:mode=off provider=mock egress=deny')
    assert.equal(probeToolBodyCalls().length, 1)
    loop.runtime.close()
  })

  it('refuses to install itself as an enforcer backed by synthetic answers', async () => {
    await assert.rejects(async () => mountLoop(jeyConfig({ mode: 'enforce' })), (e: unknown) => {
      assert.ok(e instanceof ConfigError, `expected ConfigError, got ${String(e)}`)
      assert.ok(e.errors.some(x => x.code === 'ENFORCE_WITH_MOCK'), JSON.stringify(e.errors))
      return true
    })
  })

  it('will not apply a decision whose snapshot moved while the provider was thinking', async () => {
    // R04: the adapter used to hand the *captured* snapshot back into the apply check, so
    // freshness compared a ref with itself and could only answer "fresh". Here a real
    // `agent/pre-step` for the same agent is admitted while the decision is still open —
    // the same dispatch the loop itself performs — and the late answer must be refused.
    const loop = await mountLoop(jeyConfig({ mode: 'shadow', limits: { deadlineMs: 20000 } }))
    loop.provider.hold(1)
    const turn = runTurn(loop.ctx, loop.agent, 'note this down')
    await loop.provider.holding
    await admitStep(loop, 'new instruction arrived mid-inference')
    loop.provider.release()
    await turn

    const records = decisions(loop.runtime)
    assert.equal(records.length, 1, JSON.stringify(records.map(r => r.reasonCodes)))
    assert.equal(records[0]?.stale, true, 'a decision computed against superseded state must be marked stale')
    assert.ok(records[0]?.reasonCodes.includes('stale-snapshot'), JSON.stringify(records[0]?.reasonCodes))
    loop.runtime.close()
  })

  it('discards a stale decision in shadow without restricting the call', async () => {
    // Discarding a judgment and acting on it are different things. Shadow means the host's
    // own decision stands; the stale path used to escalate to a denial there because no
    // approval channel existed, which made shadow restrict execution.
    const loop = await mountLoop(jeyConfig({ mode: 'shadow', limits: { deadlineMs: 20000 } }))
    loop.provider.hold(1)
    const turn = runTurn(loop.ctx, loop.agent, 'note this down')
    await loop.provider.holding
    await admitStep(loop, 'instruction arrived while the provider was thinking')
    loop.provider.release()
    await turn

    const [record] = decisions(loop.runtime)
    assert.equal(record?.stale, true)
    assert.equal(probeToolBodyCalls().length, 1, 'a discarded judgment must not stop the call')
    assert.equal(record?.hostDecision, 'allow', 'the row still records what the host decided')
    loop.runtime.close()
  })

  it('escalates the same stale decision once the mode is allowed to tighten', async () => {
    const loop = await mountLoop(jeyConfig({
      mode: 'enforce', provider: { kind: 'local', local: localProviderBlock() }, egress: localEgress(),
      limits: { deadlineMs: 20000 },
    }))
    loop.provider.hold(1)
    const turn = runTurn(loop.ctx, loop.agent, 'note this down')
    await loop.provider.holding
    await admitStep(loop, 'instruction arrived while the provider was thinking')
    loop.provider.release()
    await turn

    const [record] = decisions(loop.runtime)
    assert.equal(record?.stale, true)
    assert.equal(record?.action, 'deny', 'no approval channel here, so the escalation is a denial')
    assert.ok(record?.reasonCodes.includes('approval-channel-absent'), JSON.stringify(record?.reasonCodes))
    assert.equal(probeToolBodyCalls().length, 0, 'enforce may act on a required check it cannot validate')
    loop.runtime.close()
  })

  it('does nothing at all when the assessment feature is switched off', async () => {
    // This switch was wired to a condition that could never be true
    // (`toolAssessment && ... && !toolAssessment`), so every tool call still paid for a
    // model request while the operator believed the feature was off.
    const loop = await mountLoop(jeyConfig({ features: { toolAssessment: false } }))
    await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.equal(loop.provider.calls, 0, 'a disabled feature must not reach the provider')
    assert.deepEqual(decisions(loop.runtime), [], 'and must not record an observation it never made')
    assert.equal(probeToolBodyCalls().length, 1, 'the host keeps its own decision')
    loop.runtime.close()
  })

  it('refuses a purpose the egress allowlist does not name, before any bytes leave', async () => {
    const loop = await mountLoop(jeyConfig({
      mode: 'enforce',
      provider: {
        kind: 'local',
        local: {
          endpoint: 'http://127.0.0.1:9', tokenRef: 'env:JEY_TEST_TOKEN', ownership: 'external',
          expectedModel: { requested: 'any', revision: 'any' },
        },
      },
      egress: {
        mode: 'local-only', allowedOrigins: ['http://127.0.0.1:9'], allowedPurposes: ['tool-relevance'],
      },
    }))
    await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.equal(loop.provider.calls, 0, 'tool-assessment was never allowlisted for egress')
    assert.equal(loop.provider.seen.length, 0, 'no request may be assembled for a purpose that cannot leave')
    const records = decisions(loop.runtime)
    assert.equal(records.length, 1, JSON.stringify(loop.runtime.records.map(r => [r.kind, r.reasonCodes])))
    assert.ok(records[0]?.reasonCodes.some(r => r.startsWith('purpose-not-allowed')), JSON.stringify(records[0]?.reasonCodes))
    loop.runtime.close()
  })

  it('refuses locally when there are more questions than the configured cap', async () => {
    const loop = await mountLoop(jeyConfig({ limits: { maxQuestions: 2 } }))
    await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.equal(loop.provider.calls, 0, 'a request over the cap must not be sent to be rejected')
    const [record] = decisions(loop.runtime)
    assert.ok(record?.reasonCodes.some(r => r.startsWith('local-limit:maxQuestions')), JSON.stringify(record?.reasonCodes))
    assert.equal(record?.questionStatuses.every(s => s.status === 'error'), true)
    loop.runtime.close()
  })

  it('will not let a mismatched calibration upgrade raw probabilities into a deny', async () => {
    // R06: `calibrationAvailable` used to be `config.calibration !== undefined`, so any
    // calibration block — fitted for another model, another template, another task —
    // turned an uncalibrated probability into a denial.
    const loop = await mountLoop(jeyConfig({
      mode: 'enforce',
      provider: { kind: 'local', local: localProviderBlock() },
      egress: localEgress(),
      calibration: {
        id: 'fitted-for-something-else',
        appliesTo: {
          model: { requested: 'org/not-this-model', revision: 'f'.repeat(40) },
          templateDigest: 'sha256:not-this-template', task: 'tool-assessment',
        },
        conflictAskAtOrAbove: 0.8, conflictDenyAtOrAbove: 0.9, goalBelow: 0.2, evidenceBelow: 0.2,
      },
    }), { 'conflicts-with-constraint': 0.99, 'advances-goal': 0.9, 'evidence-sufficient': 0.9 })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    const [record] = decisions(loop.runtime)
    // This loop composes no approval service, so the escalation lands as a denial, and the
    // reason codes have to make clear it was the absent channel rather than the borrowed
    // calibration that denied. approval.test.ts covers the channel-present path.
    assert.equal(record?.action, 'deny', JSON.stringify(record?.reasonCodes))
    assert.ok(!record?.reasonCodes.includes('probability:conflict'),
      'a borrowed calibration must never deny on the merits')
    assert.ok(record?.reasonCodes.includes('approval-channel-absent'), JSON.stringify(record?.reasonCodes))
    assert.ok(record?.reasonCodes.includes('calibration-unapplied:calibration-model-requested'),
      JSON.stringify(record?.reasonCodes))
    assert.ok(record?.reasonCodes.includes('calibration-unapplied:calibration-answers-uncalibrated'),
      'the observation itself says uncalibrated, and that has to be the reason given')
    loop.runtime.close()
  })

  it('applies calibrated thresholds only when the answering identity really matches', async () => {
    const id = 'heldout-2026-09'
    const appliesTo = {
      model: {
        requested: 'org/weights', revision: 'a'.repeat(40), weightsDigest: `sha256:${'b'.repeat(64)}`,
        tokenizerRevision: 'c'.repeat(40), quantization: 'Q4_K_M',
      },
      templateDigest: 'sha256:tmpl', task: 'tool-assessment' as const,
    }
    const loop = await mountLoop(jeyConfig({
      mode: 'enforce',
      provider: { kind: 'local', local: localProviderBlock(appliesTo.model) },
      egress: localEgress(),
      calibration: {
        id, appliesTo, conflictAskAtOrAbove: 0.8, conflictDenyAtOrAbove: 0.9, goalBelow: 0.2, evidenceBelow: 0.2,
      },
    }), undefined, {
      // The provider that answers claims the fitted identity and carries calibrated values.
      provider: new MockProvider(
        { 'conflicts-with-constraint': 0.99, 'advances-goal': 0.9, 'evidence-sufficient': 0.9 },
        'answer',
        {
          calibrationId: id,
          identity: {
            kind: 'local', requestedModel: appliesTo.model.requested, modelRevision: appliesTo.model.revision,
            weightsDigest: appliesTo.model.weightsDigest.replace(/^sha256:/, ''),
            tokenizerRevision: appliesTo.model.tokenizerRevision,
            templateDigest: appliesTo.templateDigest, quantization: appliesTo.model.quantization,
          },
        },
      ),
    })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    const [record] = decisions(loop.runtime)
    assert.equal(record?.action, 'deny', JSON.stringify(record?.reasonCodes))
    assert.ok(record?.reasonCodes.includes('probability:conflict'), JSON.stringify(record?.reasonCodes))
    assert.equal(record?.synthetic, true, 'even so, the row still says the answer was synthetic')
    loop.runtime.close()
  })

  it('refuses to mount a feature that is not implemented instead of silently ignoring it', async () => {
    for (const [label, override] of [
      ['toolRelevance', { features: { toolAssessment: true, toolRelevance: true } }],
      ['presentationFilter', { features: { toolAssessment: true, presentationFilter: true } }],
    ] as const) {
      await assert.rejects(async () => mountLoop(jeyConfig(override)), (error: unknown) => {
        assert.ok(error instanceof ConfigError, `${label}: ${String(error)}`)
        assert.ok(error.errors.some(e => e.code === 'FEATURE_NOT_IMPLEMENTED'),
          `${label}: ${JSON.stringify(error.errors)}`)
        return true
      })
    }
  })

  it('keeps two sessions from sharing a goal, a history or a task version', async () => {
    // R03 was exactly this: one plugin-wide `goalText`, so whichever agent spoke last
    // became the other one's task. Everything below goes through real turns.
    const loop = await mountLoop(jeyConfig(), undefined, {
      repeat: true,
      sessions: ['session-A', 'session-B'],
    })
    const [agentA, agentB] = [loop.agents[0] as Agent, loop.agents[1] as Agent]
    await runTurn(loop.ctx, agentA, 'session A goal: find the failing test')
    await runTurn(loop.ctx, agentB, 'session B goal: rewrite the release notes')

    const goals = loop.provider.seen.map(r => (r.state as { call: { goal: string | null } }).call.goal)
    assert.deepEqual(goals, ['session A goal: find the failing test', 'session B goal: rewrite the release notes'],
      'each request must carry its own session goal, not whoever spoke last')
    assert.equal(loop.provider.seen[0]?.snapshot.sessionId, 'session-A')
    assert.equal(loop.provider.seen[1]?.snapshot.sessionId, 'session-B')
    // B speaking must not advance A's task revision counter, or the two share an envelope.
    assert.equal(loop.provider.seen[0]?.snapshot.taskVersion, 1)
    assert.equal(loop.provider.seen[1]?.snapshot.taskVersion, 1)
    // Requirements are still unknown: nothing here parses prose into a trusted limit.
    const constraintsOf = (index: number): readonly unknown[] => {
      const state = loop.provider.seen[index]?.state as { call?: { constraints?: readonly unknown[] } } | undefined
      return state?.call?.constraints ?? ['<missing>']
    }
    assert.deepEqual(constraintsOf(0), [], 'no structured policy source means no claimed constraints')
    assert.equal(constraintsOf(1).length, 0)
    loop.runtime.close()
  })

  it('pauses a path after three real failures and blocks the fourth before dispatch', async () => {
    // Everything here goes through the production write path: the tool genuinely fails,
    // `tools/result` genuinely records it, and the fourth call must be refused because of
    // what was recorded. Seeding a pause by hand would prove nothing about the wiring.
    const loop = await mountLoop(
      jeyConfig({ limits: { maxIdenticalFailures: 3 } }),
      undefined,
      { repeat: true, failTool: true },
    )
    for (let turn = 0; turn < 4; turn += 1) await runTurn(loop.ctx, loop.agent, 'repeat the same safe call')

    assert.equal(probeToolBodyCalls().length, 3, 'the fourth identical failing call must never reach the body')
    assert.equal(loop.provider.calls, 3, 'a recorded fact needs no model, so the paused turn must not pay for one')
    const paused = decisions(loop.runtime).at(-1)
    assert.equal(paused?.action, 'deny')
    assert.ok(paused?.reasonCodes.some(c => c.startsWith('hard-rule:path-paused')), JSON.stringify(paused?.reasonCodes))
    // Four decisions and four execution rows: the refusal is recorded as what it was
    // (`not-dispatched`) instead of being left to inference from a missing row.
    const rows = scanJournal(`${loop.lines.join('\n')}\n`).confirmed
    assert.equal(rows.filter(r => r.kind === 'decision').length, 4)
    const executions = rows.filter(r => r.kind === 'execution')
    assert.equal(executions.length, 4)
    assert.deepEqual(executions.map(r => r.kind === 'execution' && r.status),
      ['failed', 'failed', 'failed', 'not-dispatched'])
    assert.equal((executions.at(-1) as { failureCode: string }).failureCode, 'jey-denied')
    loop.runtime.close()
  })

  it('stops observing once the plugin instance is disposed', async () => {
    const loop = await mountLoop(jeyConfig())
    await runTurn(loop.ctx, loop.agent, 'first')
    assert.equal(loop.provider.calls, 1)
    loop.runtime.close()

    await runTurn(loop.ctx, loop.agent, 'second')
    assert.equal(loop.provider.calls, 1, 'a disposed instance must leave no listener behind')
    assert.equal(decisions(loop.runtime).length, 1)
  })

  it('refuses to ask a provider about a call whose own arguments do not fit the budget', async () => {
    const keys = 120
    const previous = process.env.JEY_PROBE_ARG_KEYS
    process.env.JEY_PROBE_ARG_KEYS = String(keys)
    try {
      const loop = await mountLoop(jeyConfig({ limits: { maxStateBytes: 256 } }))
      await runTurn(loop.ctx, loop.agent, 'note this down')

      assert.equal(loop.provider.calls, 0, 'a request that cannot carry the call must not be sent')
      const [record] = decisions(loop.runtime)
      assert.ok(record)
      assert.ok(record.reasonCodes.some(c => c.startsWith('insufficient-context:')), JSON.stringify(record.reasonCodes))
      // Correlation is by the minted requestId, not by publishing a digest of the
      // arguments: a short argument set is one guess away from being reversed, which is
      // why `publicSnapshot` drops it when no audit key is configured.
      assert.match(record.requestId, /^req_/)
      assert.equal(record.snapshot.callDigest, null, 'no key means no published argument digest')
      assert.ok(record.truncatedPaths.some(p => p.startsWith('insufficient:')), JSON.stringify(record.truncatedPaths))
      assert.equal(record.action, 'abstain', 'in shadow Jev adds no restriction of its own')
      // Execution is deliberately not asserted here: the widened arguments also violate
      // the probe tool's own parameter schema, so the host rejects the call before Jev's
      // abstain could matter. Whether a denial came from Jev or from the host is visible
      // in the audit record's reasonCodes, which is the point of recording them.
      loop.runtime.close()
    } finally {
      if (previous === undefined) delete process.env.JEY_PROBE_ARG_KEYS
      else process.env.JEY_PROBE_ARG_KEYS = previous
    }
  })

  it('fails closed on the very call whose audit row could not be written', async () => {
    // R07: the failed write only raised a flag, so the call that discovered it still
    // dispatched and only the *next* one was refused. A setting named fail-closed must
    // not let one unaudited action through.
    resetProbeToolBodyCalls()
    const loop = await mountLoop(jeyConfig({
      audit: { onFailure: 'fail-closed-before-dispatch' },
    }), { 'advances-goal': 0.9, 'evidence-sufficient': 0.9, 'conflicts-with-constraint': 0.1 }, { failAudit: true })
    await runTurn(loop.ctx, loop.agent, 'note this down')

    assert.equal(probeToolBodyCalls().length, 0, 'the call whose own row did not land must not run')
    assert.equal(loop.runtime.auditBlocked, true)
    loop.runtime.close()
  })

  it('bounds the in-memory decision rows to the configured retention', async () => {
    // R08: `retainedEvents` limited the journal, while the adapter's own array grew one
    // entry per call for the lifetime of the host process.
    const loop = await mountLoop(jeyConfig({ audit: { retainedEvents: 1 } }))
    for (let turn = 0; turn < 4; turn += 1) await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.ok(loop.runtime.records.length <= 1, `retained ${loop.runtime.records.length} rows for a limit of 1`)
    loop.runtime.close()
  })

  it('publishes an argument digest only when a key makes it irreversible', async () => {
    const previous = process.env.JEY_AUDIT_KEY
    process.env.JEY_AUDIT_KEY = 'a-key-that-never-leaves-this-test'
    try {
      const loop = await mountLoop(jeyConfig())
      await runTurn(loop.ctx, loop.agent, 'note this down')
      const [record] = decisions(loop.runtime)
      const digest = record?.snapshot.callDigest
      assert.match(String(digest), /^hmac:/, 'keyed, so publishable')
      assert.ok(typeof digest === 'string' && digest.length > 'hmac:'.length)
      loop.runtime.close()
    } finally {
      if (previous === undefined) delete process.env.JEY_AUDIT_KEY
      else process.env.JEY_AUDIT_KEY = previous
    }
  })

  it('records the three stages separately so a prediction cannot read as an outcome', async () => {
    const loop = await mountLoop(jeyConfig())
    await runTurn(loop.ctx, loop.agent, 'note this down')
    const [record] = decisions(loop.runtime)
    assert.ok(record)
    assert.equal(record.action, 'abstain', 'what policy said')
    assert.equal(record.hostDecision, 'allow', 'what the host decided')
    assert.equal(record.execution, null, 'what actually ran is a separate stage, never inferred from the first two')
    assert.deepEqual(record.questionStatuses.map(o => o.status), ['answered', 'answered', 'answered'])
    loop.runtime.close()
  })
})
