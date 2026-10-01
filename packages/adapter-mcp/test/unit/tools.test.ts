/**
 * Behaviour of the MCP tools without a transport in the way: the identity a call is recorded
 * under, what cancellation does to work in flight, and the two refusals that must happen
 * before any byte leaves — egress and budget.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import { after, describe, it } from 'node:test'
import { DecisionCoordinator } from 'jev-core'
import type { DecisionRequest } from 'jev-contracts'
import { MockProvider } from 'jev-provider-mock'
import { runTool, type McpRuntime, type ToolOutcome } from '../../src/tools.ts'
import { providerFor } from '../../src/provider.ts'
import type { JeyConfig } from 'jev-core'

const base = {
  schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' },
  egress: { mode: 'deny' }, limits: {}, features: {}, audit: {},
} as const

function runtime(config: Record<string, unknown>, provider: MockProvider): McpRuntime {
  const coordinator = new DecisionCoordinator(provider, {
    limits: {
      maxConcurrent: 4, maxQueue: 8, deadlineMs: 5000, perTurnCalls: 100, perSessionCalls: 1000,
      maxQueuePerSession: 4,
    },
    now: () => Date.now(),
  })
  return { config: config as unknown as JeyConfig, coordinator, provider, now: () => Date.now() }
}

after(async () => { /* nothing to tear down; providers here are in-process */ })

describe('mcp tool behaviour', () => {
  it('records its own identity, never one the caller supplied', async () => {
    const provider = new MockProvider()
    const call = runtime({ ...base }, provider)
    const outcome = await runTool(call, 'jev_check',
      // Rejected as unknown keys, so the attempt itself is the assertion.
      { claim: 'does it hold', evidence: 'because I said so', sessionId: 'someone-elses-session' },
      new AbortController().signal)
    assert.equal(outcome.kind, 'protocol', JSON.stringify(outcome))

    const good = await runTool(runtime({ ...base }, provider), 'jev_check',
      { claim: 'does it hold', evidence: 'because I said so' }, new AbortController().signal)
    assert.equal(good.kind, 'ok', JSON.stringify(good))
    const request = provider.seen.at(-1) as DecisionRequest
    assert.equal(request.snapshot.sessionId, 'mcp')
    assert.equal(request.snapshot.agentId, 'mcp')
    assert.equal(request.purpose, 'evidence-check', 'a caller cannot pick the purpose either')
    await call.coordinator.close()
  })

  it('aborts an in-flight judgement and leaves nothing queued', async () => {
    const provider = new MockProvider()
    provider.hold(1)
    const call = runtime({ ...base, limits: { deadlineMs: 10_000 } }, provider)
    const controller = new AbortController()
    const pending = runTool(call, 'jev_check', { claim: 'c', evidence: 'e' }, controller.signal)
    await provider.holding
    controller.abort()
    const outcome = await pending
    assert.equal(outcome.kind, 'tool', JSON.stringify(outcome))
    if (outcome.kind === 'tool') {
      assert.equal(outcome.code, 'CANCELLED')
      assert.equal(outcome.retryable, false, 'a cancelled judgement is not a retry-me-later')
    }
    assert.equal(call.coordinator.stats.inflight, 0, 'no orphan work after cancellation')
    assert.equal(call.coordinator.stats.queued, 0)
    await call.coordinator.close()
  })

  it('refuses to send state through a denied egress path, before the provider is called', async () => {
    const provider = new MockProvider()
    const call = runtime({
      ...base,
      provider: {
        kind: 'local',
        local: {
          endpoint: 'http://127.0.0.1:9', tokenRef: 'env:JEY_TEST_TOKEN', ownership: 'external',
          expectedModel: { requested: 'any', revision: 'any' },
        },
      },
      // deny is the default, and the MCP adapter honours it the same way the plugin does.
      egress: { mode: 'deny' },
    }, provider)
    const outcome = await runTool(call, 'jev_check', { claim: 'c', evidence: 'e' }, new AbortController().signal)
    assert.equal(outcome.kind, 'tool', JSON.stringify(outcome))
    if (outcome.kind === 'tool') assert.equal(outcome.code, 'EGRESS_DENIED')
    assert.equal(provider.calls, 0, 'a denied path must not be probed first')
    await call.coordinator.close()
  })

  it('refuses an input that cannot fit the state budget instead of judging a shortened one', async () => {
    const call = runtime({ ...base, limits: { maxStateBytes: 600 } }, new MockProvider())
    const outcome = await runTool(call, 'jev_check',
      { claim: 'c', evidence: 'x'.repeat(4000) }, new AbortController().signal)
    assert.equal(outcome.kind, 'tool', JSON.stringify(outcome))
    if (outcome.kind === 'tool') {
      assert.equal(outcome.code, 'INSUFFICIENT_CONTEXT')
      assert.equal(outcome.retryable, false)
    }
    await call.coordinator.close()
  })

  it('answers a rank request with no candidates instead of inventing a winner', async () => {
    const provider = new MockProvider()
    const call = runtime({ ...base }, provider)
    const outcome = await runTool(call, 'jev_rank',
      { instruction: 'best fit', candidates: [] }, new AbortController().signal)
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
    if (outcome.kind !== 'ok') return
    const structured = outcome.structured as {
      noneApplicable: boolean, abstained: boolean, ordering: string[], provider: { synthetic: boolean }
    }
    assert.equal(structured.noneApplicable, true)
    // `abstained` means a model was asked and declined. Nobody was asked here, so the two
    // flags must not be synonyms: conflating them would hide a real abstention rate.
    assert.equal(structured.abstained, false)
    assert.equal(structured.provider.synthetic, true, 'an answer built without a model says so')
    assert.deepEqual(structured.ordering, [])
    assert.equal(provider.calls, 0, 'nothing to ask means nothing sent')
    await call.coordinator.close()
  })

  it('keeps a declined answer declined, never a zero', async () => {
    const call = runtime({ ...base }, new MockProvider({}, 'abstain'))
    const outcome = await runTool(call, 'jev_check', { claim: 'c', evidence: 'e' }, new AbortController().signal)
    assert.equal(outcome.kind, 'ok', JSON.stringify(outcome))
    if (outcome.kind !== 'ok') return
    const structured = outcome.structured as { abstained: boolean, pYes: number }
    assert.equal(structured.abstained, true)
    assert.equal(structured.pYes, 0, 'the number is present, and the flag says it means nothing')
    await call.coordinator.close()
  })

  it('reports an unreachable service as retryable, not as an unsupported capability', async () => {
    // Nothing here is stubbed: the service is a genuine HTTP listener, so the path travelled
    // is the production one — LocalProvider, loopback egress allowlist, token header.
    // The outage answers `capabilities` too, and must not be dressed up as a model that
    // declined to answer these questions.
    const run = await callAgainst({ capabilities: refuse(503), decide: refuse(503) })
    assert.equal(run.outcome.kind, 'tool', JSON.stringify(run.outcome))
    if (run.outcome.kind === 'tool') {
      assert.equal(run.outcome.code, 'LOCAL_NOT_READY')
      assert.equal(run.outcome.retryable, true, 'a service that is down may come back; that is what retryable means')
    }
    assert.equal(run.calls, 0, 'the outage was seen before a decision was sent into it')
  })

  it('keeps a service that declines these questions apart from one that is broken', async () => {
    // Capabilities are served properly, so the 422 below comes from the decision itself —
    // the only honest route to `UNSUPPORTED_CAPABILITY`.
    const run = await callAgainst({ capabilities: SERVE_CAPABILITIES, decide: refuse(422) })
    assert.equal(run.outcome.kind, 'tool', JSON.stringify(run.outcome))
    if (run.outcome.kind === 'tool') {
      assert.equal(run.outcome.code, 'UNSUPPORTED_CAPABILITY')
      assert.equal(run.outcome.retryable, false, 'retrying a refused question asks for the same refusal')
    }
    assert.equal(run.calls, 1, 'the decision request really went out over the socket')
  })

  it('refuses every mismatched local model pin before sending decision state', async () => {
    for (const [field, value] of [
      ['requestedModel', 'other-model'], ['modelRevision', 'other-revision'],
      ['weightsDigest', 'sha256:other'], ['tokenizerRevision', 'other-tokenizer'],
      ['quantization', 'q4'], ['synthetic', true],
    ] as const) {
      const run = await callAgainst({
        capabilities: answer(200, { ...CAPABILITIES, provider: { ...CAPABILITIES.provider, [field]: value } }),
        decide: refuse(422),
      })
      assert.equal(run.outcome.kind, 'tool', field)
      if (run.outcome.kind === 'tool') {
        assert.equal(run.outcome.code, 'UNSUPPORTED_CAPABILITY', field)
        assert.equal(run.outcome.retryable, false, field)
      }
      assert.equal(run.calls, 0, `${field}: only the state-free capabilities probe is permitted`)
    }
  })

  it('says what the answering side said about retrying, not what this adapter guesses', async () => {
    // The local protocol distinguishes a request this service is still willing to take
    // (429, retryable) from one it gave up on computing (504, not retryable). A retry table
    // owned by the adapter would overwrite that with a guess, and a client would hammer a
    // service that just said it timed out doing the work.
    const overloaded = await callAgainst({ capabilities: SERVE_CAPABILITIES, decide: refuse(429) })
    const timedOut = await callAgainst({ capabilities: SERVE_CAPABILITIES, decide: refuse(504) })
    if (overloaded.outcome.kind !== 'tool' || timedOut.outcome.kind !== 'tool') {
      throw new Error(`expected tool errors, got ${JSON.stringify([overloaded.outcome, timedOut.outcome])}`)
    }
    assert.equal(overloaded.outcome.code, 'QUEUE_FULL')
    assert.equal(overloaded.outcome.retryable, true, `429: ${JSON.stringify(overloaded.outcome)}`)
    assert.equal(timedOut.outcome.code, 'TIMEOUT')
    assert.equal(timedOut.outcome.retryable, false, `504: ${JSON.stringify(timedOut.outcome)}`)
  })
})

const CAPABILITIES = {
  provider: {
    kind: 'local', providerVersion: '1', requestedModel: 'm', resolvedModel: 'm', modelRevision: 'r',
    weightsDigest: 'sha256:w', tokenizerRevision: 't', templateDigest: 'sha256:tpl', quantization: 'q8',
    synthetic: false,
  },
  questionKinds: ['boolean'], maxInputBytes: 32_768, maxQuestions: 8, cancellation: 'cooperative',
} as const

function portOf(socket: ReturnType<typeof createServer>): number {
  const address = socket.address()
  return typeof address === 'object' && address !== null ? address.port : 0
}

type Handler = (res: ServerResponse) => void

const answer = (status: number, body: unknown): Handler => res => {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** An HTTP-level refusal, which is how the local protocol carries a structured `error.code`. */
const refuse = (status: number): Handler => answer(status, { error: 'declined by the service' })

const SERVE_CAPABILITIES: Handler = answer(200, CAPABILITIES)

/**
 * One `jev_check` against a real listener on a real port, with the allowlist narrowed to
 * that port. The call count is returned alongside the outcome because these tests have to
 * tell "refused before anything was sent" apart from "sent, then refused".
 */
async function callAgainst(
  handlers: { readonly capabilities: Handler; readonly decide: Handler },
): Promise<{ readonly outcome: ToolOutcome; readonly calls: number }> {
  const socket = createServer((req, res) => {
    if (req.url === '/v1/capabilities') handlers.capabilities(res)
    else handlers.decide(res)
  })
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve))
  process.env.JEY_TEST_TOKEN = 'test-token'
  const call = localRuntime(portOf(socket))
  try {
    const outcome = await runTool(call, 'jev_check', { claim: 'c', evidence: 'e' }, new AbortController().signal)
    return { outcome, calls: (call.provider as unknown as { calls: number }).calls }
  } finally {
    delete process.env.JEY_TEST_TOKEN
    await call.coordinator.close()
    socket.close()
  }
}

/** A real LocalProvider against a loopback port, under an allowlist that admits only that port. */
function localRuntime(port: number): McpRuntime {
  // `endpoint` is the service *origin*: the client appends `/v1/capabilities` and
  // `/v1/decide` itself. Writing the decide path here makes both probes land on
  // `/v1/decide/v1/…`, and the 422 test below would then "pass" on a 404 instead.
  const config = {
    schemaVersion: '1', mode: 'shadow',
    provider: {
      kind: 'local',
      local: {
        endpoint: `http://127.0.0.1:${port}`, tokenRef: 'env:JEY_TEST_TOKEN',
        ownership: 'external', expectedModel: {
          requested: 'm', revision: 'r', weightsDigest: 'sha256:w', tokenizerRevision: 't', quantization: 'q8',
        },
      },
    },
    egress: { mode: 'local-only', allowedPurposes: ['evidence-check'], allowedOrigins: [`http://127.0.0.1:${port}`] },
    limits: { deadlineMs: 4000 }, features: {}, audit: {},
  } as unknown as JeyConfig
  const provider = providerFor(config)
  return {
    config, provider, now: () => Date.now(),
    coordinator: new DecisionCoordinator(provider, {
      limits: { maxConcurrent: 4, maxQueue: 8, deadlineMs: 4000, perTurnCalls: 10, perSessionCalls: 100, maxQueuePerSession: 4 },
      now: () => Date.now(),
    }),
  }
}
