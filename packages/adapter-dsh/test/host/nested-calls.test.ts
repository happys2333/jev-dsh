/**
 * Nested dispatch: one model-requested call that owns several real tool executions.
 *
 * HOST-10 asks for the case where a transport makes two child calls. The published PTC
 * runtime is not installable here (the alpha.2 package ships only the abstract service
 * definition, and no node implementation exists in the lockfile), so these tests drive the
 * same entry point the PTC bridge uses — `ToolRuntime.execute` with the parent's
 * `rootCallId` and `token` — and say so rather than claiming the bridge itself ran.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool, type ToolDefinition, type ToolExecutionInput } from '@deepseek-ai/dsh-tools'
import { scanJournal, type AuditEvent } from 'jev-core'
import { mountJey, type JeyRuntime } from '../../src/jey-plugin.ts'
import { MockProvider } from 'jev-provider-mock'
import { scriptedLlmPlugin } from '../../src/scripted-llm.ts'

const LEAF = 'jey_leaf'
const COMPOSITE = 'jey_composite'
const LEAF_ARGUMENT = 'same-leaf-argument'

const leafBodies: string[] = []
const compositeBodies: string[] = []

function leafTool(failing: boolean): ToolDefinition {
  return defineTool({
    name: LEAF,
    description: 'Nested target. Records every body entry so a blocked child is visible.',
    parameters: { note: { type: 'string', description: 'argument', required: true } },
    output: {
      schema: { type: 'object', properties: { note: { type: 'string', required: true } }, additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: value.note }] },
    },
    async execute(args) {
      leafBodies.push(args.note as string)
      if (failing) throw new Error('nested-calls: leaf failure')
      return { note: args.note as string }
    },
  })
}

/** The bridge shape: fresh call id per child, the parent's root, the parent's token. */
function compositeTool(ctx: Context): ToolDefinition {
  return defineTool({
    name: COMPOSITE,
    description: 'Dispatches two identical nested leaf calls through the real registry.',
    parameters: { note: { type: 'string', description: 'argument', required: true } },
    output: {
      schema: { type: 'object', properties: { note: { type: 'string', required: true } }, additionalProperties: false },
      render(_args, value) { return [{ type: 'text', text: value.note }] },
    },
    async execute(args, exec) {
      for (const child of [1, 2]) {
        const input: ToolExecutionInput = {
          callId: ToolCallId(`${String(exec.callId)}:nested:${child}`),
          name: LEAF,
          arguments: { note: LEAF_ARGUMENT },
          rootCallId: exec.rootCallId,
          parent: exec.token,
          ...(exec.agent !== undefined ? { agent: exec.agent } : {}),
          signal: exec.signal,
        }
        await ctx.tools.execute(input)
      }
      compositeBodies.push(args.note as string)
      return { note: args.note as string }
    },
  })
}

interface Harness {
  readonly ctx: Context
  readonly agent: Agent
  readonly runtime: JeyRuntime
  readonly lines: string[]
}

async function mountNested(maxIdenticalFailures = 3): Promise<Harness> {
  leafBodies.length = 0
  compositeBodies.length = 0
  const lines: string[] = []
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(scriptedLlmPlugin)
  const runtime = mountJey(ctx, {
    schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' }, egress: { mode: 'deny' },
    limits: { deadlineMs: 20000, maxIdenticalFailures }, features: { toolAssessment: true }, audit: {},
  }, { provider: new MockProvider(), audit: { writeLine: line => { lines.push(line) } } })
  const harness = await mountAgentLoopTestHarness(ctx)
  const agent = await harness.create(SessionId('jey-nested-agent'), { provider: 'jey-probe', model: 'nested-model' })
  return { ctx, agent, runtime, lines }
}

function rootCall(agent: Agent, name: string, callId: string, parent?: ToolExecutionInput['parent']): ToolExecutionInput {
  return {
    callId: ToolCallId(callId),
    name,
    arguments: { note: 'root' },
    agent,
    ...(parent === undefined ? {} : { parent }),
    signal: new AbortController().signal,
  }
}

function decisions(runtime: JeyRuntime): readonly AuditEvent[] {
  return runtime.records.filter(r => r.kind === 'decision') as readonly AuditEvent[]
}

describe('nested dispatch through the real registry', () => {
  it('judges and reports every child call, not just the transport', async () => {
    const { ctx, agent, runtime, lines } = await mountNested()
    ctx.tools.register(leafTool(false))
    ctx.tools.register(compositeTool(ctx))

    await ctx.tools.execute(rootCall(agent, COMPOSITE, 'root-1'))

    assert.equal(leafBodies.length, 2, 'both children ran')
    assert.equal(compositeBodies.length, 1)
    const rows = scanJournal(`${lines.join('\n')}\n`).confirmed
    assert.deepEqual(rows.filter(r => r.kind === 'diagnostic').map(() => 1).length, 1, 'one mount row')
    const executed = rows.filter(r => r.kind === 'execution')
    assert.equal(executed.length, 3, 'parent and two children each get their own outcome row')
    if (executed.some(r => r.kind !== 'execution')) return
    assert.deepEqual(executed.map(r => r.kind === 'execution' && r.toolName).sort(), [COMPOSITE, LEAF, LEAF])
    assert.equal(new Set(executed.map(r => r.kind === 'execution' && r.requestId)).size, 3,
      'each row correlates to a distinct decision, so no child can consume another’s row')
    assert.equal(decisions(runtime).length, 3, 'and each was decided before dispatch')
    await ctx.fiber.dispose()
  })

  it('counts one attempt once when the transport made two identical calls', async () => {
    const { ctx, agent, runtime } = await mountNested(3)
    ctx.tools.register(leafTool(true))
    ctx.tools.register(compositeTool(ctx))

    // Three root attempts, each dispatching two identical children. Double counting would
    // pause the path after attempt two; missing the children would never pause it at all.
    for (const call of ['root-1', 'root-2', 'root-3']) await ctx.tools.execute(rootCall(agent, COMPOSITE, call))

    assert.equal(leafBodies.length, 5,
      'attempts 1 and 2 ran both children; the third paused the path mid-attempt')
    assert.equal(compositeBodies.length, 3, 'the transport itself was never refused')
    const paused = decisions(runtime).filter(r => r.action === 'deny'
      && r.reasonCodes.some(c => c.startsWith('hard-rule:path-paused')))
    assert.equal(paused.length, 1, JSON.stringify(decisions(runtime).map(r => r.reasonCodes)))
    await ctx.fiber.dispose()
  })

  it('refuses to skip the child because it is nested', async () => {
    // With no audit key the published snapshot drops call digests entirely (P0-07), so this
    // test sets one to make the identity folding visible.
    const previousKey = process.env.JEY_AUDIT_KEY
    process.env.JEY_AUDIT_KEY = 'nested-test-key'
    const { ctx, agent, runtime, lines } = await mountNested()
    ctx.tools.register(leafTool(false))
    ctx.tools.register(compositeTool(ctx))
    await ctx.tools.execute(rootCall(agent, COMPOSITE, 'root-1'))

    const rows = scanJournal(`${lines.join('\n')}\n`).confirmed.filter(r => r.kind === 'decision') as AuditEvent[]
    assert.equal(rows.length, 3, 'one decision per dispatch: nesting is not a reason to skip the check')
    // The two children are the same tool with the same arguments under the same root call, so
    // they share one identity by design — that is what makes the counting in the test above
    // meaningful. The transport is a different tool, so it is a different identity.
    const digests = new Set(rows.map(r => r.snapshot.callDigest))
    assert.equal(digests.size, 2, 'children fold onto each other, not onto the parent')
    assert.equal([...digests].every(d => typeof d === 'string' && d.startsWith('hmac:')), true,
      'a keyed log publishes only the keyed digest')
    assert.equal(rows.every(r => r.action === 'abstain'), true, 'shadow observed all three')
    assert.equal(rows.every(r => !r.egressOccurred), true, 'and nothing left the process')
    await ctx.fiber.dispose()
    if (previousKey === undefined) delete process.env.JEY_AUDIT_KEY
    else process.env.JEY_AUDIT_KEY = previousKey
  })
})
