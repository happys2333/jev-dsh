/**
 * The advertised surface and the enforced surface have to be one thing. These tests are the
 * check on that: what `tools/list` publishes is what the handler compiles, and the keys the
 * specification says a caller may never supply are refused *because the published schema*
 * refuses them, not because a `if` in the handler happens to name them.
 *
 * @module
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, it } from 'node:test'
import { LEGACY_TOOL_NAMES, MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, TOOL_OUTPUT_SCHEMAS } from '../../src/schema.ts'
import { inputErrors } from '../../src/tools.ts'

const here = dirname(fileURLToPath(import.meta.url))
const sourceDir = resolve(here, '../../src')

/** What spec §12 forbids a caller from steering, in the shapes a caller would try. */
const FORGED_KEYS = [
  'sessionId', 'hostAttested', 'agentId', 'endpoint', 'endpointOrigin', 'model', 'modelPath',
  'apiKey', 'apiKeyRef', 'credentialRef', 'tokenRef', 'mode', 'egress', 'policy', 'templates',
  'purpose', 'budget',
] as const

const VALID_ARGS: Record<string, Record<string, unknown>> = {
  jey_check: { claim: 'the file is a test fixture', evidence: 'it asserts on its own output' },
  jey_choose: {
    instruction: 'pick one', options: [
      { id: 'a', description: 'first' }, { id: 'b', description: 'second' },
    ],
  },
  jey_rank: { instruction: 'which is safer', candidates: [{ id: 'x', text: 'a sandbox' }] },
}

function schemaOf(name: string): Record<string, unknown> {
  return TOOL_INPUT_SCHEMAS[name as keyof typeof TOOL_INPUT_SCHEMAS] as Record<string, unknown>
}

describe('mcp advertised surface', () => {
  it('publishes exactly the three v1 tools, under the names this repository ships', () => {
    assert.deepEqual([...MCP_TOOL_NAMES], ['jey_check', 'jey_choose', 'jey_rank'])
    // The handoff called these `adl_*`. The rename is recorded, not silently dropped: a
    // client configured from the handoff needs to know which name replaced which.
    assert.deepEqual(Object.values(LEGACY_TOOL_NAMES), ['adl_check', 'adl_choose', 'adl_rank'])
    for (const name of Object.values(LEGACY_TOOL_NAMES)) {
      assert.ok(!MCP_TOOL_NAMES.includes(name as never), `${name} is not advertised`)
    }
  })

  it('is a schema the compiler accepts, closed to keys it did not declare', () => {
    const ajv = new Ajv2020({ strict: true })
    for (const name of MCP_TOOL_NAMES) {
      const schema = schemaOf(name)
      assert.equal(schema.additionalProperties, false, `${name} must not admit undeclared keys`)
      assert.doesNotThrow(() => ajv.compile(JSON.parse(JSON.stringify(schema))), `${name} input schema does not compile`)
      assert.doesNotThrow(() => ajv.compile(JSON.parse(JSON.stringify(TOOL_OUTPUT_SCHEMAS[name]))), `${name} output schema does not compile`)
    }
  })

  it('refuses a forged key through the very schema it publishes', () => {
    for (const name of MCP_TOOL_NAMES) {
      const baseline = inputErrors(name, VALID_ARGS[name])
      assert.deepEqual(baseline, [], `${name} rejects its own documented input: ${baseline.join(', ')}`)
      for (const key of FORGED_KEYS) {
        const withForgedKey = { ...VALID_ARGS[name], [key]: 'caller-controlled' }
        const problems = inputErrors(name, withForgedKey)
        assert.ok(problems.length > 0, `${name} accepted ${key} — the published schema is not what the handler checks`)
      }
    }
  })

  it('names an answering model and its synthetic flag on every output', () => {
    for (const name of MCP_TOOL_NAMES) {
      const output = TOOL_OUTPUT_SCHEMAS[name] as { required: string[]; properties: { provider: { required: string[] } } }
      assert.ok(output.required.includes('provider'), `${name} answers without saying who answered`)
      assert.ok(output.required.includes('requestId'))
      for (const field of ['kind', 'resolvedModel', 'synthetic']) {
        assert.ok(output.properties.provider.required.includes(field), `${name} omits provider.${field}`)
      }
      // An abstention must be representable: without the flag a declined answer and a zero
      // look identical to the client, which is the failure spec §3.2 exists to prevent.
      assert.ok(output.required.includes('abstained'), `${name} cannot record a decline`)
    }
  })

  it('does not import the host it is not running inside', () => {
    const files = readdirSync(sourceDir).filter(f => f.endsWith('.ts'))
    assert.ok(files.length >= 5, 'the source directory looks wrong; refusing to assert on nothing')
    for (const file of files) {
      const text = readFileSync(join(sourceDir, file), 'utf8')
      assert.ok(!text.includes('@deepseek-ai/'), `${file} imports DSH: the MCP adapter must run without it`)
      assert.ok(!text.includes('jey-adapter-dsh'), `${file} imports the DSH adapter`)
    }
  })

  it('keeps credentials out of the source, as references only', () => {
    const files = readdirSync(sourceDir).filter(f => f.endsWith('.ts'))
    const secretish = /(api[_-]?key\s*[:=]\s*['"`][^'"`]{8,}|bearer\s+[a-z0-9._-]{16,}|sk-[a-z0-9]{16,})/i
    for (const file of files) {
      const text = readFileSync(join(sourceDir, file), 'utf8')
      const found = text.match(secretish)
      assert.equal(found, null, `${file} appears to carry a literal credential: ${found?.[0]}`)
    }
  })
})
