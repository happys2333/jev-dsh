/**
 * Scope boundaries: which tool definition a decision is allowed to believe it saw, and
 * what Jev must never be able to do about visibility.
 *
 * Cases: HOST-08 (a global and a scoped definition sharing one name), HOST-09 (a tool the
 * host already hid), LIFE-07 (a tool-set change while a decision is open must hit only the
 * scope whose advertised catalog moved).
 *
 * @module
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { scanJournal, type AuditEvent, type AuditExecution } from 'jev-core'
import { mountJey, type JeyRuntime } from '../../src/jey-plugin.ts'
import { MockProvider } from 'jev-provider-mock'
import { PROBE_TOOL_NAME, probeTool, probeToolBodyCalls, resetProbeToolBodyCalls } from '../../src/probe-tool.ts'
import { REPEAT_LLM_ROUTE, repeatingProbeLlmPlugin } from '../../src/scripted-llm.ts'
import { probePlugin, probeSequence, probeTrace, resetProbeTrace } from '../../src/probe-plugin.ts'
import type { AssembleEvent } from '../../src/probe-plugin.ts'

const GLOBAL_BODY = 'global-dup'
const SCOPED_BODY = 'scoped-dup'

/** Which definition actually ran is only knowable from the body that was reached. */
const ranBodies: string[] = []

function dupTool(marker: string, parameter: string): ToolDefinition {
  return defineTool({
    name: 'dup',
    description: `Same name as the other registration; this one is ${marker}.`,
    parameters: { [parameter]: { type: 'string', description: 'accepted only by this definition', required: true } },
    output: {
      schema: { type: 'object', properties: { marker: { type: 'string', required: true } }, additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: value.marker }] },
    },
    async execute() {
      ranBodies.push(marker)
      return { marker }
    },
  })
}

interface Harness {
  readonly ctx: Context
  readonly a: Agent
  readonly b: Agent
  readonly runtime: JeyRuntime
  readonly provider: MockProvider
  readonly lines: string[]
}

async function mountScoped(session = 'scope-a', beforeJey?: (ctx: Context) => void): Promise<Harness> {
  ranBodies.length = 0
  resetProbeToolBodyCalls()
  const lines: string[] = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  // The repeating adapter asks for the probe tool on every other step, so *both* agents get
  // a tool call within one turn instead of only the first one.
  await ctx.plugin(repeatingProbeLlmPlugin)
  // The observer plugin records the ordered pipeline trace the timing test below reads.
  await ctx.plugin(probePlugin)
  ctx.tools.register(probeTool)
  if (beforeJey !== undefined) beforeJey(ctx)
  const provider = new MockProvider()
  const runtime = mountJey(ctx, {
    schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' }, egress: { mode: 'deny' },
    limits: { deadlineMs: 20000 }, features: { toolAssessment: true }, audit: {},
  }, { provider, audit: { writeLine: line => { lines.push(line) } } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const a = await harness.create(SessionId(session), { provider: REPEAT_LLM_ROUTE, model: 'scope-model' })
  const b = await harness.create(SessionId(`${session}-other`), { provider: REPEAT_LLM_ROUTE, model: 'scope-model' })
  return { ctx, a, b, runtime, provider, lines }
}

function callInput(agent: Agent, name: string, args: Record<string, string>, callId: string): ToolExecutionInput {
  return {
    callId: callId as ToolExecutionInput['callId'],
    name,
    arguments: args,
    agent,
    signal: new AbortController().signal,
  }
}

async function runTurn(ctx: Context, agent: Agent, text: string): Promise<void> {
  await new Promise<void>(resolve => {
    const dispose = ctx.on('agent/status', payload => {
      if (payload.agent === agent && payload.status === 'idle') {
        dispose()
        resolve()
      }
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  })
}

function decisions(runtime: JeyRuntime): readonly AuditEvent[] {
  return runtime.records.filter(r => r.kind === 'decision') as readonly AuditEvent[]
}

describe('scoped tool definitions', () => {
  it('judges a same-name tool by the definition its own scope executes', async () => {
    const { ctx, a, b, runtime } = await mountScoped()
    ctx.tools.register(dupTool(GLOBAL_BODY, 'globalArgument'))
    // Registration self-scopes to the calling context, and the nearest scope wins a name.
    a.ctx.tools.register(dupTool(SCOPED_BODY, 'scopedArgument'))

    await ctx.systemPrompt.assemble({ scope: a })
    await ctx.systemPrompt.assemble({ scope: b })
    await ctx.tools.execute(callInput(a, 'dup', { scopedArgument: 'x' }, 'call-a'))
    await ctx.tools.execute(callInput(b, 'dup', { globalArgument: 'x' }, 'call-b'))

    assert.deepEqual(ranBodies, [SCOPED_BODY, GLOBAL_BODY], 'A got its shadow, B got the global')
    const [first, second] = decisions(runtime)
    assert.ok(first !== undefined && second !== undefined, `expected two rows, got ${decisions(runtime).length}`)
    // Each decision has to be checked against the catalog *its own agent* was advertised.
    // With one global digest the second call would have been judged against A's shadowed set.
    assert.notEqual(first.snapshot.catalogDigest, second.snapshot.catalogDigest,
      'a scoped shadow must not be judged against the other scope catalog')
    await ctx.fiber.dispose()
  })

  it('leaves a hidden tool hidden: Jev registers nothing and restricts nothing', async () => {
    const { ctx, a, b } = await mountScoped()
    const registry = ctx.tools
    let registerCalls = 0
    let restrictCalls = 0
    const originalRegister = registry.register.bind(registry)
    const originalRestrict = a.ctx.tools.restrict.bind(a.ctx.tools)
    Object.defineProperty(registry, 'register', {
      configurable: true,
      value: (definition: ToolDefinition) => { registerCalls += 1; return originalRegister(definition) },
    })
    Object.defineProperty(a.ctx.tools, 'restrict', {
      configurable: true,
      value: (filter: Parameters<typeof originalRestrict>[0]) => { restrictCalls += 1; return originalRestrict(filter) },
    })

    const visibleFor = (agent: Agent): string[] => ctx.tools.schemas(agent).map(t => t.name)
    a.ctx.tools.restrict({ deny: [PROBE_TOOL_NAME] })
    assert.equal(visibleFor(a).includes(PROBE_TOOL_NAME), false, 'the host hid it for A')
    assert.equal(visibleFor(b).includes(PROBE_TOOL_NAME), true, 'B still sees it')

    const before = registerCalls + restrictCalls
    await runTurn(ctx, a, 'note this down')
    await runTurn(ctx, b, 'note this down')

    assert.equal(registerCalls, 0, 'Jev never registers a tool')
    assert.equal(restrictCalls, 1, 'only the test itself restricted')
    assert.equal(registerCalls + restrictCalls, before, 'a Jev-observed turn changed nothing')
    // …and the counters are not silently dead: one registration through the spied object
    // has to be seen, or the zero above means nothing.
    ctx.tools.register(dupTool(GLOBAL_BODY, 'globalArgument'))
    assert.equal(registerCalls, 1, 'the register spy is live')
    assert.equal(visibleFor(a).includes(PROBE_TOOL_NAME), false, 'a hidden tool came back')
    assert.equal(probeToolBodyCalls().length, 1, 'only B could run it')
    await ctx.fiber.dispose()
  })

  it('does not mark a pending decision stale for another scope’s catalog change', async () => {
    // LIFE-07's second half: an unrelated agent must not pay for somebody else's catalog
    // change. The two scopes have to be advertised *different* sets first, or this would
    // pass even with the old single shared digest.
    const { ctx, a, b, runtime, provider } = await mountScoped('scope-live-a')
    a.ctx.tools.register(dupTool(SCOPED_BODY, 'scopedArgument'))
    await ctx.systemPrompt.assemble({ scope: a })
    const forB = await ctx.systemPrompt.assemble({ scope: b })
    assert.equal(forB.tools.some(t => t.name === 'dup'), false, 'B must not see A’s shadow')

    provider.hold(1)
    const turn = runTurn(ctx, a, 'note this down')
    await provider.holding
    // Two refreshes of an unrelated scope's catalog: nothing A was shown has moved.
    await ctx.systemPrompt.assemble({ scope: b })
    await ctx.systemPrompt.assemble({ scope: b })
    provider.release()
    await turn

    const [record] = decisions(runtime)
    assert.equal(record?.stale, false, JSON.stringify(record?.reasonCodes))
    await ctx.fiber.dispose()
  })

  it('does mark it stale when the scope that is waiting got a different catalog', async () => {
    const { ctx, a, runtime, provider } = await mountScoped('scope-live-b')
    await ctx.systemPrompt.assemble({ scope: a })

    provider.hold(1)
    const turn = runTurn(ctx, a, 'note this down')
    await provider.holding
    ctx.tools.register(dupTool(GLOBAL_BODY, 'globalArgument'))
    await ctx.systemPrompt.assemble({ scope: a })
    provider.release()
    await turn

    const [record] = decisions(runtime)
    assert.equal(record?.stale, true, 'the advertised set under a live decision did move')
    assert.ok(record?.reasonCodes.includes('stale-snapshot'), JSON.stringify(record?.reasonCodes))
    assert.equal(probeToolBodyCalls().length, 1, 'shadow still lets the call through')
    await ctx.fiber.dispose()
  })

  it('still checks an agentless call instead of skipping it for want of a session', async () => {
    // HOST-11: a trusted program can reach the registry without an agent. Missing identity
    // must not become a reason to record nothing — the call is judged under the `agentless`
    // scope, and the row says what was seen.
    const { ctx, runtime } = await mountScoped('scope-agentless')
    await ctx.tools.execute({
      callId: ToolCallId('call-agentless'), name: PROBE_TOOL_NAME, arguments: { note: 'x' },
      signal: new AbortController().signal,
    } satisfies ToolExecutionInput)

    const [record] = decisions(runtime)
    assert.ok(record, 'and was recorded')
    assert.equal(record.sessionId, 'agentless', JSON.stringify(record.sessionId))
    assert.equal(record.action, 'abstain', 'shadow observed it and added no restriction')
    assert.equal(probeToolBodyCalls().length, 1, 'the call itself still ran')
    await ctx.fiber.dispose()
  })

  it('shows that a restriction made inside pre-step reaches only the next assembly', async () => {
    // The §8.2 presentation-only gate, measured rather than read off the source: the loop
    // assembles before it runs `agent/pre-step`, so anything a listener restricts there is
    // visible from the *next* assembly onward. That is why a hard filter has to live in
    // `system-prompt/assemble` and not in a step listener.
    const { ctx, a, runtime, lines } = await mountScoped('scope-timing')
    resetProbeTrace()
    let restricted = false
    ctx.on('agent/pre-step', async (payload, next) => {
      if (!restricted) {
        restricted = true
        a.ctx.tools.restrict({ deny: [PROBE_TOOL_NAME] })
      }
      void payload
      return next()
    })

    await runTurn(ctx, a, 'note this down')

    const sequence = probeSequence()
    const assemblies = probeTrace().filter(e => e.stage === 'assemble') as readonly AssembleEvent[]
    assert.ok(assemblies.length >= 2, `expected two assemblies in the turn, got ${assemblies.length}`)
    assert.ok(sequence.indexOf('assemble') < sequence.indexOf('pre-step'),
      `the loop assembles before it runs pre-step: ${JSON.stringify(sequence)}`)
    // The step that made the restriction was assembled before it, so it still carried the
    // tool; the very next step of the same turn does not. That is the whole gate: a filter
    // placed in `agent/pre-step` is one step late, by host design.
    assert.ok(assemblies[0]?.returned.includes(PROBE_TOOL_NAME),
      JSON.stringify(assemblies.map(x => x.returned)))
    assert.ok(assemblies.some(x => !x.returned.includes(PROBE_TOOL_NAME)),
      'a later assembly in the same turn reflects the restriction')
    // The consequence the gate exists to prevent: the tool the model was shown in this step
    // is no longer resolvable when the call is dispatched. Jev took part in that call — it
    // saw a normal pre-execute and abstained — and then the host refused to run something it
    // had just advertised, which the audit can only show as a failed execution under an
    // allow. A filter that lives in a step listener therefore leaves the layer endorsing a
    // call the host cannot make; only `system-prompt/assemble` shapes the advertised set.
    assert.equal(probeToolBodyCalls().length, 0, 'the advertised tool could not be executed')
    const [record] = decisions(runtime)
    assert.ok(record !== undefined, 'Jev was still consulted for the call')
    assert.equal(record.action, 'abstain')
    assert.equal(record.hostDecision, 'allow')
    const executed = scanJournal(`${lines.join('\n')}\n`).confirmed
      .filter((r): r is AuditExecution => r.kind === 'execution')
    assert.equal(executed.length, 1)
    assert.equal((executed[0] as { status: string }).status, 'failed')
    await ctx.fiber.dispose()
  })

  it('is not consulted when a plugin mounted earlier refuses the call', async () => {
    // HOST-14 in the other direction: registration order is the waterfall position, and an
    // outer listener that returns without calling next() short-circuits everyone behind it.
    // Jev adds no permission here — the call is still blocked — but it also records nothing,
    // so a refusal made upstream of Jev is visible only in the host's own log. That is a
    // limitation of being one listener among several, not something Jev can inspect.
    const { ctx, a, runtime } = await mountScoped('scope-order', earlier => {
      earlier.on('tools/pre-execute', async () => ({ kind: 'deny', reason: 'earlier-policy-denied' }))
    })
    await ctx.tools.execute(callInput(a, PROBE_TOOL_NAME, { note: 'x' }, 'call-order'))

    assert.equal(decisions(runtime).length, 0, 'Jev was never asked, so it claims nothing')
    assert.equal(probeToolBodyCalls().length, 0, 'and the call was still blocked')
    await ctx.fiber.dispose()
  })
})
