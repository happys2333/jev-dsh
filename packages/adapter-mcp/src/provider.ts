/**
 * Provider construction for the MCP server.
 *
 * Only `mock` and `local` are wired. `typesafe` is refused rather than quietly supported:
 * the cloud path is the one this repository still records as BLOCKED (no key, no call
 * budget), and a long-lived MCP process that reads an API key from the environment and
 * starts sending state to it is exactly the "discovered a key, switched to cloud" behaviour
 * spec §12 forbids. `unconfigured` is refused too — an MCP server that answers nothing has no
 * reason to be started.
 *
 * @module
 */
import { readFileSync } from 'node:fs'
import type { DecisionProvider } from 'jey-contracts'
import { LocalProvider } from 'jey-provider-local'
import { MockProvider } from 'jey-provider-mock'
import type { JeyConfig } from 'jey-core'

/** The credentials a deployment configured, resolved the same way the DSH adapter does. */
export function resolveCredential(reference: string | undefined): string | undefined {
  if (reference === undefined || reference === '') return undefined
  const separator = reference.indexOf(':')
  if (separator < 0) throw new Error(`jey-mcp: credential reference '${reference}' has no scheme`)
  const scheme = reference.slice(0, separator)
  const rest = reference.slice(separator + 1)
  if (scheme === 'env') return process.env[rest]
  if (scheme === 'file') {
    try {
      return readFileSync(rest, 'utf8').trim()
    } catch {
      return undefined
    }
  }
  // `keystore:` is the DSH adapter's concern: the MCP server has no keychain session to use.
  throw new Error(`jey-mcp: unsupported credential scheme '${scheme}'`)
}

export function providerFor(config: JeyConfig): DecisionProvider {
  const provider = config.provider
  if (provider.kind === 'mock') return new MockProvider()
  if (provider.kind === 'local') {
    const local = provider.local
    if (local === undefined) throw new Error('jey-mcp: provider.kind=local without a local block')
    return new LocalProvider({ endpoint: local.endpoint, token: () => resolveCredential(local.tokenRef) })
  }
  if (provider.kind === 'typesafe') {
    throw new Error('jey-mcp: the cloud provider is not wired here; see docs/INSTALL_MCP.md')
  }
  throw new Error(`jey-mcp: no provider implementation for '${provider.kind}'`)
}
