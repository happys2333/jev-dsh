/**
 * M2 closed loop: Jey's decision core driving a real DSH agent loop and a real
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
import { ConfigError, scanJournal, type AuditEvent, type LineSink } from 'jey-core'
import { mountJey, type JeyRuntime } from '../../src/jey-plugin.ts'
import { MockProvider } from '../../src/providers/mock.ts'
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
    features: {},
    audit: {},
    ...overrides,
  }
}

interface Loop {
  readonly ctx: Context
  readonly agent: Agent
  readonly runtime: JeyRuntime
  readonly provider: MockProvider
  readonly lines: string[]
}

interface LoopOptions {
  /** Ask for the probe tool on every step instead of exactly once. */
  readonly repeat?: boolean
  /** Make the tool body record the call and then fail. */
  readonly failTool?: boolean
}

async function mountLoop(
  config: Record<string, unknown>,
  answers?: Record<string, number>,
  options: LoopOptions = {},
): Promise<Loop> {
  resetProbeToolBodyCalls()
  setProbeToolFailure(options.failTool === true)
  const lines: string[] = []
  const audit: LineSink = { writeLine: line => { lines.push(line) } }
  const provider = new MockProvider(answers)
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const route = options.repeat === true ? REPEAT_LLM_ROUTE : PROBE_LLM_ROUTE
  await ctx.plugin(options.repeat === true ? repeatingProbeLlmPlugin : scriptedLlmPlugin)
  ctx.tools.register(probeTool)
  const runtime = mountJey(ctx, config, { provider, audit })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('jey-loop-agent'), { provider: route, model: 'loop-model' })
  return { ctx, agent, runtime, provider, lines }
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

function decisions(runtime: JeyRuntime): readonly AuditEvent[] {
  return runtime.records.filter(r => r.kind === 'decision')
}

describe('Jey closed loop on a real DSH agent', () => {
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
    assert.deepEqual(scanJournal(`${loop.lines.join('\n')}\n`).isolated, [])
    assert.equal(scanJournal(`${loop.lines.join('\n')}\n`).confirmed.length, 1)
    loop.runtime.close()
  })

  it('does not consult anything at all while off', async () => {
    const loop = await mountLoop(jeyConfig({ mode: 'off' }))
    await runTurn(loop.ctx, loop.agent, 'note this down')
    assert.equal(loop.provider.calls, 0)
    assert.deepEqual(decisions(loop.runtime), [])
    assert.deepEqual(loop.lines, [])
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
    assert.equal(scanJournal(`${loop.lines.join('\n')}\n`).confirmed.length, 4)
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
      assert.equal(record.snapshot.callDigest !== null, true, 'the call is still identified in the audit trail')
      assert.ok(record.truncatedPaths.some(p => p.startsWith('insufficient:')), JSON.stringify(record.truncatedPaths))
      assert.equal(record.action, 'abstain', 'in shadow Jey adds no restriction of its own')
      // Execution is deliberately not asserted here: the widened arguments also violate
      // the probe tool's own parameter schema, so the host rejects the call before Jey's
      // abstain could matter. Whether a denial came from Jey or from the host is visible
      // in the audit record's reasonCodes, which is the point of recording them.
      loop.runtime.close()
    } finally {
      if (previous === undefined) delete process.env.JEY_PROBE_ARG_KEYS
      else process.env.JEY_PROBE_ARG_KEYS = previous
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
