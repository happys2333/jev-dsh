#!/usr/bin/env node
/**
 * The stdio entry point. Everything it decides comes from a config file and the environment
 * at startup — never from a tool call, and never by noticing that some API key happens to be
 * present. Logs go to stderr: stdout carries protocol bytes only.
 *
 * @module
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { DecisionCoordinator, loadConfig, type HostCapabilities } from 'jey-core'
import { providerFor } from './provider.ts'
import { createJeyServer } from './server.ts'
import type { McpRuntime } from './tools.ts'

/**
 * What this host can do, stated as facts rather than assumptions: an MCP client is not a DSH
 * agent, there is no approval seam to ask through, and there is nothing here whose tool
 * visibility Jey could restrict. Each capability the config asks for that the host cannot back
 * is refused at load, the same way the DSH adapter refuses it.
 */
export const MCP_HOST_CAPABILITIES: HostCapabilities = {
  approvalChannel: false,
  scopedRestrict: false,
  postExecuteWaterfall: false,
}

export function log(message: string): void {
  process.stderr.write(`jey-mcp: ${message}\n`)
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at < 0 ? undefined : argv[at + 1]
}

export function runtimeFrom(configPath: string): McpRuntime {
  const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'))
  // The same validator the plugin runs: a config that would be refused on a DSH host is
  // refused here, rather than starting and then abstaining.
  const config = loadConfig(raw, MCP_HOST_CAPABILITIES)
  const provider = providerFor(config)
  const coordinator = new DecisionCoordinator(provider, {
    limits: {
      maxConcurrent: config.limits.maxConcurrent,
      maxQueue: config.limits.maxQueue,
      deadlineMs: config.limits.deadlineMs,
      perTurnCalls: config.limits.perTurnCalls,
      perSessionCalls: config.limits.perSessionCalls,
      // One session may not queue more than the host can run at once, or it starves the rest.
      maxQueuePerSession: Math.max(1, config.limits.maxConcurrent),
    },
    now: () => Date.now(),
    onDiagnostic: event => { log(`${event.kind} ${event.key}`) },
  })
  return { config, coordinator, provider, now: () => Date.now() }
}

export async function serve(argv: readonly string[]): Promise<void> {
  const configPath = flag(argv, '--config') ?? process.env.JEY_CONFIG
  if (configPath === undefined) throw new Error('--config <jey config json> is required (or JEY_CONFIG)')
  const runtime = runtimeFrom(configPath)
  const server = createJeyServer(runtime)
  await server.connect(new StdioServerTransport())
  log(`listening on stdio (mode=${runtime.config.mode} provider=${runtime.config.provider.kind} egress=${runtime.config.egress.mode})`)
  let shuttingDown = false
  const shutdown = (why: string): void => {
    if (shuttingDown) return
    shuttingDown = true
    log(`${why}; closing the coordinator and exiting`)
    // Closing the coordinator first cancels the runs still holding a provider connection —
    // otherwise the process outlives its client and keeps computing for nobody.
    void runtime.coordinator.close()
      .catch((error: unknown) => log(`shutdown failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { process.exitCode = 0 })
  }
  // stdio has exactly one client, so a closed transport means there is nobody left to answer.
  server.onclose = () => { shutdown('the transport closed') }
  // The SDK's stdio transport never notices the client hanging up on its own — it only removes
  // its listeners when something calls `close()`. Without this, a request still outstanding at
  // the provider keeps the process alive for a client that is already gone.
  process.stdin.once('end', () => { shutdown('stdin ended') })
  process.once('SIGINT', () => { shutdown('SIGINT') })
  process.once('SIGTERM', () => { shutdown('SIGTERM') })
}

// Only run when this file is the process entry point, so importing it from a test does not
// start a transport. Comparing resolved file URLs covers both `src/main.ts` (type-stripped)
// and `dist/main.js` (the published bin).
const entry = process.argv[1] === undefined ? '' : pathToFileURL(resolve(process.argv[1])).href
if (import.meta.url === entry) {
  serve(process.argv.slice(2)).catch((error: unknown) => {
    // Startup failures are stderr-only: a client whose stdout yields a non-JSON line cannot
    // finish initialize, and the operator loses the reason.
    log(`failed to start: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
