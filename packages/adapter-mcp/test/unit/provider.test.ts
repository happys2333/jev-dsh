/**
 * Which providers this server will start with, and how a credential is looked up. Both are
 * startup-only decisions: nothing a client sends can change them, and the two refusals here
 * (a cloud provider, and a keystore reference) exist precisely so this cannot be negotiated
 * later by whoever happens to have set an environment variable.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, describe, it } from 'node:test'
import { loadConfig, type JeyConfig } from 'jey-core'
import { MockProvider } from 'jey-provider-mock'
import { LocalProvider } from 'jey-provider-local'
import { MCP_HOST_CAPABILITIES } from '../../src/main.ts'
import { providerFor, resolveCredential } from '../../src/provider.ts'

const here = dirname(fileURLToPath(import.meta.url))
const example = (name: string): JeyConfig => loadConfig(
  JSON.parse(readFileSync(resolve(here, `../../../../config/examples/${name}`), 'utf8')) as unknown,
  MCP_HOST_CAPABILITIES,
)

const tempDir = mkdtempSync(join(tmpdir(), 'jey-mcp-provider-'))
after(() => rmSync(tempDir, { recursive: true, force: true }))

describe('mcp provider selection', () => {
  it('starts from the two example configs the install document ships', () => {
    // The docs tell an operator to run these two files; this is the check that they boot.
    assert.ok(providerFor(example('mcp-mock-shadow.json')) instanceof MockProvider)
    assert.ok(providerFor(example('mcp-shadow-local.json')) instanceof LocalProvider)
  })

  it('refuses the cloud provider instead of noticing a key and using it', () => {
    const cloud = {
      schemaVersion: '1', mode: 'shadow',
      provider: { kind: 'typesafe', typesafe: { credentialRef: 'env:TYPESAFE_API_KEY', model: 'm', endpointOrigin: 'https://api.example.com' } },
      egress: { mode: 'allowlist', allowedPurposes: ['evidence-check'],
        destinations: [{ id: 'api', endpoint: 'https://api.example.com', purposes: ['evidence-check'] }] },
      limits: {}, features: {}, audit: {},
    } as const
    // Whatever the environment holds, this path is a refusal that points at the documentation.
    const thrown = (() => { try { providerFor(loadConfig(cloud as unknown, MCP_HOST_CAPABILITIES)); return null } catch (e) { return e } })()
    assert.ok(thrown instanceof Error)
    assert.match((thrown as Error).message, /docs\/INSTALL_MCP\.md/)
  })

  it('resolves a credential only from an explicit reference', () => {
    process.env.JEY_MCP_TEST_SECRET = 'from-the-environment'
    const file = join(tempDir, 'token')
    writeFileSync(file, '  from-a-file \n', 'utf8')
    try {
      assert.equal(resolveCredential('env:JEY_MCP_TEST_SECRET'), 'from-the-environment')
      assert.equal(resolveCredential(`file:${file}`), 'from-a-file', 'surrounding whitespace is not part of the secret')
      assert.equal(resolveCredential('env:JEY_MCP_TEST_ABSENT'), undefined)
      assert.equal(resolveCredential(`file:${join(tempDir, 'nope')}`), undefined)
      assert.equal(resolveCredential(undefined), undefined)
      assert.throws(() => resolveCredential('keystore:jey'), /unsupported credential scheme/)
      assert.throws(() => resolveCredential('just-a-value'), /no scheme/)
    } finally {
      delete process.env.JEY_MCP_TEST_SECRET
    }
  })

  it('refuses to start without a provider it can actually talk to', () => {
    const off = example('off-minimal.json')
    assert.throws(() => providerFor(off), /no provider implementation for 'unconfigured'/)
    const localWithoutBlock = {
      schemaVersion: '1', mode: 'shadow', provider: { kind: 'local' },
      egress: { mode: 'local-only', allowedOrigins: ['http://127.0.0.1:8732'], allowedPurposes: ['evidence-check'] },
      limits: {}, features: {}, audit: {},
    } as unknown
    // `loadConfig` requires the block, so reaching `providerFor` without one means the two
    // validators disagree — which is the thing worth asserting here.
    const thrown = (() => { try { providerFor(localWithoutBlock as JeyConfig); return null } catch (e) { return e } })()
    assert.ok(thrown instanceof Error)
    assert.match((thrown as Error).message, /local/)
  })
})
