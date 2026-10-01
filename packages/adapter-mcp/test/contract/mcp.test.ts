/**
 * The MCP surface as a client actually meets it: Jev running as its own process, talking over
 * real stdio pipes, driven by the reference SDK client rather than by our own code. Everything
 * the acceptance for this adapter names is asserted here — the handshake, the advertised tools,
 * one call per tool, that stdout carries protocol bytes and nothing else, that a protocol
 * failure and a failed judgement are two different shapes, that a cancellation reaches the
 * provider and leaves no orphan work behind, and that a caller cannot forge a host identity.
 *
 * @module
 *
 * The `MCP-0n` labels are the handoff's `contracts/test-matrix.csv` cases: 01 the real-client
 * handshake (`b`/`c` are its two call paths, mock and real service), 02 stdout purity,
 * 03 protocol-vs-tool errors, 04 permission isolation, 05 a client that goes away. The
 * disconnect half of 05 — no orphan process — is asserted inside MCP-02, because that is the
 * only test that owns the child's stdio.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, TOOL_OUTPUT_SCHEMAS } from '../../src/schema.ts'

const here = dirname(fileURLToPath(import.meta.url))
/** The same entry point `bin.jey-mcp` runs, from source so these tests need no build step. */
const ENTRY = resolve(here, '../../src/main.ts')
const TOKEN = 'local-token-never-printed'
const CHECK_ARGS = { claim: 'the fixture asserts on its own output', evidence: 'this file names itself in its own description' }

const tempDir = mkdtempSync(join(tmpdir(), 'jey-mcp-'))
const openClients = new Set<Client>()
const openChildren = new Set<ReturnType<typeof spawn>>

// A child left connected keeps `node --test` waiting on the process tree long after the
// assertions are done, so every client and every raw spawn is registered and shut down here.
after(async () => {
  for (const client of openClients) await client.close().catch(() => undefined)
  for (const child of openChildren) child.kill()
  rmSync(tempDir, { recursive: true, force: true })
})

function configPath(name: string, config: unknown): string {
  const path = join(tempDir, `${name}.json`)
  writeFileSync(path, JSON.stringify(config), 'utf8')
  return path
}

/** The minimum a config must say to load. A mock may observe, and never enforce. */
const MOCK_CONFIG = {
  schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' },
  egress: { mode: 'deny' }, limits: { deadlineMs: 3000 }, features: {}, audit: {},
}

/** A local provider aimed at the test's own listener, with only that origin allowlisted. */
function localConfig(port: number, limits: Record<string, number> = {}): unknown {
  return {
    schemaVersion: '1', mode: 'shadow',
    provider: {
      kind: 'local',
      local: {
        endpoint: `http://127.0.0.1:${port}`, tokenRef: 'env:JEY_CONTRACT_TOKEN', ownership: 'external',
        expectedModel: { requested: 'contract-model', revision: 'r1' },
      },
    },
    egress: { mode: 'local-only', allowedOrigins: [`http://127.0.0.1:${port}`], allowedPurposes: ['evidence-check'] },
    limits: { deadlineMs: 5000, maxConcurrent: 1, maxQueue: 4, ...limits },
    features: {}, audit: {},
  }
}

async function connect(configFile: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', ENTRY, '--config', configFile],
    env: { ...getDefaultEnvironment(), JEY_CONTRACT_TOKEN: TOKEN },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'jey-contract-client', version: '0.0.0' })
  openClients.add(client)
  await client.connect(transport)
  return client
}

const CAPABILITIES = {
  provider: {
    kind: 'local', providerVersion: '1', requestedModel: 'contract-model', resolvedModel: 'contract-model',
    modelRevision: 'r1', weightsDigest: 'sha256:w', tokenizerRevision: 't', templateDigest: 'sha256:tpl',
    quantization: 'q8', synthetic: false,
  },
  questionKinds: ['boolean', 'choice', 'score'], maxInputBytes: 65_536, maxQuestions: 8,
  cancellation: 'cooperative',
}

interface FakeService {
  readonly port: number
  /** How many `/v1/decide` bodies arrived. */
  readonly decides: () => number
  /** How many of them the *client* hung up on, rather than us answering. */
  readonly givenUp: () => number
  readonly lastDecide: () => Record<string, unknown> | null
  readonly setBehaviour: (next: 'hang' | 'refuse' | 'answer') => void
  readonly close: () => Promise<void>
}

/**
 * The local inference service, as a process outside Jev. It answers `capabilities` and is told
 * what to do with `decide`, so a test can make it hang, refuse, or answer.
 */
async function startService(): Promise<FakeService> {
  let behaviour: 'hang' | 'refuse' | 'answer' = 'hang'
  let decides = 0
  let givenUp = 0
  let last: Record<string, unknown> | null = null

  const server = createServer((req, res) => {
    if (req.url === '/v1/capabilities') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(CAPABILITIES))
      return
    }
    if (req.url !== '/v1/decide') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'no such path' }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk as Buffer))
    req.on('end', () => {
      decides += 1
      last = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (behaviour === 'refuse') {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not ready' }))
        return
      }
      if (behaviour === 'answer') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({
          schemaVersion: '1', requestId: last.requestId, snapshot: last.snapshot, status: 'ok',
          provider: CAPABILITIES.provider,
          outcomes: [{
            id: 'claim-holds', status: 'answered',
            answer: {
              kind: 'boolean', pYes: 0.82,
              probability: { origin: 'native-logits', calibration: 'uncalibrated', calibrationId: null },
            },
          }],
          timing: { queueMs: 0, inferenceMs: 3, totalMs: 3 },
          usage: { inputTokens: 10, outputTokens: 1, costUsd: null, costBasis: 'reported' },
          egress: { occurred: true, destinationId: null },
        }))
        return
      }
      // 'hang': hold the socket open and never answer, until the client gives up on it.
      req.on('aborted', () => { givenUp += 1 })
      res.on('close', () => { givenUp += 1 })
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const address = server.address()
  return {
    port: typeof address === 'object' && address !== null ? address.port : 0,
    decides: () => decides,
    givenUp: () => givenUp,
    lastDecide: () => last,
    setBehaviour: next => { behaviour = next },
    close: () => new Promise<void>(resolve => {
      // A held socket must not keep teardown waiting if a test failed before its cancellation.
      server.closeAllConnections()
      server.close(() => resolve())
    }),
  }
}

async function waitFor(predicate: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let waited = 0; waited < ms; waited += 25) {
    if (predicate()) return
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`timed out waiting for ${what}`)
}

interface ToolFailure { readonly code: string; readonly retryable: boolean; readonly message: string }

/** The JSON this server writes when a judgement could not be made; see server.ts. */
function toolError(result: unknown): ToolFailure {
  const content = (result as { content: unknown[] }).content
  const first = content[0] as { text: string }
  return (JSON.parse(first.text) as { error: ToolFailure }).error
}

describe('mcp over stdio', () => {
  it('MCP-01 completes initialize and tools/list with an independent client process', async () => {
    const client = await connect(configPath('handshake', MOCK_CONFIG))
    assert.equal(client.getServerVersion()?.name, 'jev')
    // The server states its own limits, so a client that reads nothing but the instructions
    // still cannot mistake this for an executor.
    assert.match(client.getInstructions() ?? '', /never executes/i)
    assert.ok(client.getServerCapabilities()?.tools !== undefined)

    const listed = await client.listTools()
    assert.deepEqual(listed.tools.map(t => t.name), [...MCP_TOOL_NAMES])
    for (const tool of listed.tools) {
      const name = tool.name as (typeof MCP_TOOL_NAMES)[number]
      assert.deepEqual(tool.inputSchema, TOOL_INPUT_SCHEMAS[name], `${name} publishes a schema it does not validate with`)
      assert.deepEqual(tool.outputSchema, TOOL_OUTPUT_SCHEMAS[name])
      assert.equal(tool.annotations?.readOnlyHint, true, `${name} claims it can write`)
      assert.equal(tool.annotations?.destructiveHint, false)
      assert.equal(tool.annotations?.openWorldHint, false, `${name} claims it reaches outside`)
    }
    await client.close()
  })

  it('accepts legacy jey_check while advertising Jev names', async () => {
    const client = await connect(configPath('legacy-name', MOCK_CONFIG))
    try {
      const result = await client.callTool({name: 'jey_check', arguments: {...CHECK_ARGS}})
      assert.notEqual(result.isError, true)
      assert.ok(result.structuredContent)
    } finally { await client.close() }
  })

  it('MCP-01b answers all three tools, with the text and the structure as one thing', async () => {
    const client = await connect(configPath('calls', MOCK_CONFIG))
    const ajv = new Ajv2020({ strict: false })
    const calls = [
      ['jev_check', { ...CHECK_ARGS }],
      ['jev_choose', {
        instruction: 'which is safer',
        options: [{ id: 'sandbox', description: 'run it contained' }, { id: 'host', description: 'run it here' }],
      }],
      ['jev_rank', {
        instruction: 'which is safer',
        candidates: [{ id: 'sandbox', text: 'contained' }, { id: 'host', text: 'here' }],
      }],
    ] as const
    for (const [name, args] of calls) {
      const result = await client.callTool({ name, arguments: { ...args } })
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result.content)}`)
      const structured = result.structuredContent as Record<string, unknown>
      assert.ok(structured !== undefined, `${name} returned no structuredContent`)
      const first = (result.content as [{ type: string; text: string }])[0]
      assert.equal(first.type, 'text')
      // The compatibility channel is the same bytes, not a paraphrase of them.
      assert.equal(first.text, JSON.stringify(structured), `${name}'s two channels disagree`)
      const validate = ajv.compile(JSON.parse(JSON.stringify(TOOL_OUTPUT_SCHEMAS[name])))
      assert.equal(validate(structured), true,
        `${name} answer fails its own published output schema: ${ajv.errorsText(validate.errors)}`)
      // Every answer says who produced it, and a synthetic one says that too.
      assert.equal((structured.provider as { synthetic: boolean }).synthetic, true,
        `${name} presented a mock answer without the synthetic flag`)
    }
    await client.close()
  })

  it('MCP-03 keeps a protocol failure apart from a judgement that could not be made', async () => {
    const client = await connect(configPath('errors', MOCK_CONFIG))
    // Unknown tool and malformed arguments are protocol problems: JSON-RPC errors, no result.
    const unknown = await client.callTool({ name: 'jey_execute', arguments: {} }).catch(e => e)
    assert.ok(unknown instanceof McpError, `unknown tool produced ${JSON.stringify(unknown)}`)
    assert.equal((unknown as McpError).code, ErrorCode.MethodNotFound)

    const malformed = await client.callTool({ name: 'jev_check', arguments: { claim: 'only a claim' } }).catch(e => e)
    assert.ok(malformed instanceof McpError, `missing evidence produced ${JSON.stringify(malformed)}`)
    assert.equal((malformed as McpError).code, ErrorCode.InvalidParams)
    assert.match((malformed as McpError).message, /evidence/)

    // A well-formed request the tool cannot answer is a *result* with `isError` set. A client
    // that treated the two above the same way would retry a bad argument forever.
    const tooBig = await client.callTool({ name: 'jev_check', arguments: { claim: 'c', evidence: 'x'.repeat(40_000) } })
    assert.equal(tooBig.isError, true)
    const failure = toolError(tooBig)
    assert.equal(failure.code, 'INSUFFICIENT_CONTEXT')
    assert.equal(failure.retryable, false, 'a state that cannot fit will not fit on the second try either')
    assert.equal(tooBig.structuredContent, undefined, 'a failure is not an answer, so it has no structuredContent')
    await client.close()
  })

  it('MCP-04 refuses a forged host identity without sending anything', async () => {
    const service = await startService()
    service.setBehaviour('refuse')
    try {
      const client = await connect(configPath('forge', localConfig(service.port)))
      const forged = await client.callTool({
        name: 'jev_check',
        arguments: {
          ...CHECK_ARGS,
          sessionId: 'a-session-that-is-not-mine',
          hostAttested: true,
          endpoint: 'http://127.0.0.1:1',
          tokenRef: 'env:JEY_CONTRACT_TOKEN',
          mode: 'enforce',
        },
      }).catch(e => e)
      assert.ok(forged instanceof McpError, `the server accepted caller-supplied identity: ${JSON.stringify(forged)}`)
      assert.equal((forged as McpError).code, ErrorCode.InvalidParams)
      assert.equal(service.decides(), 0, 'a refused call still put state on the wire')

      // And the same tool does answer when nobody tries to name its own session, under an
      // identity this process chose rather than one the caller supplied.
      const answered = await client.callTool({ name: 'jev_check', arguments: { ...CHECK_ARGS } })
      assert.equal(service.decides(), 1)
      assert.equal(answered.isError, true, 'the service refuses, which is a judgement attempt not a protocol fault')
      const snapshot = service.lastDecide()?.snapshot as { sessionId: string; agentId: string }
      assert.equal(snapshot.sessionId, 'mcp')
      assert.equal(snapshot.agentId, 'mcp')
      await client.close()
    } finally {
      await service.close()
    }
  })

  it('MCP-02 puts only protocol bytes on stdout, and stops when its client disconnects', async () => {
    const service = await startService()
    service.setBehaviour('refuse')
    try {
      const child = spawn(process.execPath,
        ['--disable-warning=ExperimentalWarning', ENTRY, '--config', configPath('purity', localConfig(service.port))],
        { stdio: ['pipe', 'pipe', 'pipe'], env: { ...getDefaultEnvironment(), JEY_CONTRACT_TOKEN: TOKEN } })
      openChildren.add(child)
      /** Every line the server wrote to stdout, kept verbatim for the purity scan below. */
      const lines: string[] = []
      let pending = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        pending += chunk
        for (;;) {
          const at = pending.indexOf('\n')
          if (at < 0) break
          lines.push(pending.slice(0, at))
          pending = pending.slice(at + 1)
        }
      })
      child.stderr.on('data', (chunk: string) => { stderr += chunk })

      // Routing is a second pass over the recorded lines, so a stray non-JSON line fails the
      // assertion below instead of throwing inside a reader and hiding what was written.
      const replyTo = (line: string): Record<string, unknown> | null => {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>
          return typeof parsed.id === 'number' ? parsed : null
        } catch {
          return null
        }
      }
      const replies = new Map<number, Record<string, unknown>>()
      const pump = (): void => {
        for (const line of lines) {
          const parsed = replyTo(line)
          if (parsed !== null) replies.set(parsed.id as number, parsed)
        }
      }
      const interval = setInterval(pump, 5)
      let id = 0
      const request = async (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => {
        const mine = ++id
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: mine, method, params })}\n`)
        await waitFor(() => replies.has(mine), `${method} to be answered`)
        return replies.get(mine) as Record<string, unknown>
      }

      const initialized = await request('initialize', {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw-probe', version: '0' },
      })
      assert.ok(initialized.result !== undefined, JSON.stringify(initialized))
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      await request('tools/list')
      await request('tools/call', { name: 'jev_check', arguments: { ...CHECK_ARGS } })
      await request('tools/call', { name: 'jev_check', arguments: { claim: 'no evidence' } })
      await request('tools/call', { name: 'jey_no_such_tool', arguments: {} })
      await request('prompts/list')

      // Closing the client's end of the pipe is the disconnect: a stdio server with nobody
      // left to serve must not stay alive holding its in-flight work.
      child.stdin.end()
      const exited = await Promise.race([
        new Promise<string>(r => child.once('close', (code) => r(`closed code=${code}`))),
        new Promise<string>(r => setTimeout(() => r('hanging'), 4000)),
      ])
      child.kill()
      clearInterval(interval)
      pump()
      assert.equal(exited, 'closed code=0', 'the server did not shut down cleanly when its client disconnected')

      const seen = lines.filter(line => line.trim() !== '')
      assert.ok(seen.length >= 6, `only ${seen.length} frames came back; the session cannot have completed`)
      for (const line of seen) {
        let parsed: Record<string, unknown> | undefined
        try {
          parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
          throw new Error(`a stdout line was not JSON at all: ${JSON.stringify(line)}`)
        }
        assert.equal(parsed.jsonrpc, '2.0', `a stdout line was not JSON-RPC: ${line}`)
        assert.ok(parsed.result !== undefined || parsed.error !== undefined,
          `a stdout frame was neither a response nor a notification: ${line}`)
      }
      assert.match(stderr, /listening on stdio/, 'the startup line did not go to stderr')
      assert.ok(!seen.some(line => line.includes(TOKEN)), 'the local service token appeared on stdout')
      assert.ok(!stderr.includes(TOKEN), 'the local service token appeared on stderr')
      assert.ok(!seen.some(line => line.includes('jey-mcp:')), 'a log line was written to the protocol channel')
    } finally {
      await service.close()
    }
  })

  it('MCP-05b shuts the process down when the client disappears with a call in flight', async () => {
    // The other half of "no orphan work": not a polite cancellation but a client that simply
    // goes away while a decision is still outstanding against a service that is not answering.
    const service = await startService()
    const child = spawn(process.execPath,
      ['--disable-warning=ExperimentalWarning', ENTRY, '--config', configPath('vanish', localConfig(service.port, { deadlineMs: 30_000 }))],
      { stdio: ['pipe', 'pipe', 'pipe'], env: { ...getDefaultEnvironment(), JEY_CONTRACT_TOKEN: TOKEN } })
    openChildren.add(child)
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { out += chunk })
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'walks-away', version: '0' } } })}\n`)
      await waitFor(() => out.includes('"id":1'), 'the handshake reply', 5000)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'jev_check', arguments: { ...CHECK_ARGS } } })}\n`)
      await waitFor(() => service.decides() === 1, 'the decision to reach the service')

      child.stdin.end()
      const exited = await Promise.race([
        new Promise<string>(r => child.once('close', code => r(`closed code=${code}`))),
        new Promise<string>(r => setTimeout(() => r('hanging'), 4000)),
      ])
      assert.equal(exited, 'closed code=0',
        'the server kept running after its client vanished, with a provider request still open')
    } finally {
      child.kill()
      await service.close()
    }
  })

  it('MCP-05 propagates a cancellation to the provider and keeps no orphan work', async () => {
    const service = await startService()
    // A deadline far outside the test's own window, so anything observed here is observed
    // because the client cancelled, not because a clock ran out.
    const client = await connect(configPath('cancel', localConfig(service.port, { maxConcurrent: 1, deadlineMs: 30_000 })))
    try {
      const controller = new AbortController()
      const pending = client.callTool({ name: 'jev_check', arguments: { ...CHECK_ARGS } }, undefined, { signal: controller.signal })
      await waitFor(() => service.decides() === 1, 'the decision to reach the service')
      controller.abort()
      // The SDK settles an aborted request with a failure of its own, not with a result.
      const outcome = await pending.catch(e => e)
      assert.ok(outcome instanceof Error, `the cancelled call resolved with ${JSON.stringify(outcome)}`)
      // The proof that the cancellation went *through* Jev rather than stopping at it: the
      // service sees its own socket hang up, seconds before its deadline could have done it.
      await waitFor(() => service.givenUp() >= 1, 'the service to see the client hang up', 3000)

      // The one running slot has to be free again. If the cancelled run leaked it, the next
      // call would queue behind a request nobody is waiting for and time out.
      service.setBehaviour('refuse')
      const second = await Promise.race([
        client.callTool({ name: 'jev_check', arguments: { ...CHECK_ARGS } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the second call never ran')), 6000)),
      ])
      assert.equal(second.isError, true)
      const failure = toolError(second)
      assert.equal(failure.code, 'LOCAL_NOT_READY', `expected a fresh decision, got ${JSON.stringify(failure)}`)
      assert.equal(service.decides(), 2, 'the second decision reached the service')
      await client.close()
    } finally {
      await service.close()
    }
  })

  it('MCP-01c answers from a real service, and records whose answer it is', async () => {
    const service = await startService()
    service.setBehaviour('answer')
    try {
      const client = await connect(configPath('answered', localConfig(service.port)))
      const result = await client.callTool({ name: 'jev_check', arguments: { ...CHECK_ARGS } })
      assert.notEqual(result.isError, true, JSON.stringify(result.content))
      const structured = result.structuredContent as Record<string, unknown>
      assert.equal(structured.pYes, 0.82)
      const provider = structured.provider as { synthetic: boolean; resolvedModel: string; kind: string }
      assert.equal(provider.synthetic, false, 'a real service answered, and this is not marked synthetic')
      assert.equal(provider.kind, 'local')
      assert.equal(provider.resolvedModel, 'contract-model')
      assert.equal((structured.probability as { calibration: string; origin: string }).calibration, 'uncalibrated',
        'an uncalibrated answer must not arrive wearing a calibration')
      assert.equal((structured.probability as { origin: string }).origin, 'native-logits')
      await client.close()
    } finally {
      await service.close()
    }
  })
})
