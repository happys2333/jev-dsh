/**
 * Captures one real stdio session against the MCP server and writes it to
 * `artifacts/mcp_stdio_session.json`, so the claims in `docs/INSTALL_MCP.md` — the two error
 * shapes, the synthetic identity on a mock answer, which stream the logs land on, and what the
 * process does when its client hangs up — are backed by recorded bytes rather than prose.
 *
 * Deliberately not part of the test suite: it is evidence gathering, and it writes a file.
 * `docs/INSTALL_MCP.md` names it the way `docs/INSTALL_DSH.md` names `host_boot_check.mjs`.
 *
 *   node scripts/mcp_stdio_transcript.mjs [--entry <path>] [--out <path>]
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const at = argv.indexOf(name)
  return at < 0 ? fallback : argv[at + 1]
}
const entry = flag('--entry', 'packages/adapter-mcp/src/main.ts')
const out = flag('--out', join(root, 'artifacts', 'mcp_stdio_session.json'))

/** A mock provider and every egress path closed: the transcript proves nothing left the process. */
const config = {
  schemaVersion: '1', mode: 'shadow', provider: { kind: 'mock' },
  egress: { mode: 'deny' }, limits: { deadlineMs: 3000 }, features: {}, audit: {},
}

const dir = mkdtempSync(join(tmpdir(), 'jey-mcp-transcript-'))
const configPath = join(dir, 'jey-config.json')
writeFileSync(configPath, JSON.stringify(config), 'utf8')

const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', entry, '--config', configPath], {
  stdio: ['pipe', 'pipe', 'pipe'], cwd: root,
})

const frames = []
const stderrLines = []
let pending = ''
child.stdout.setEncoding('utf8')
child.stderr.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  pending += chunk
  for (;;) {
    const at = pending.indexOf('\n')
    if (at < 0) break
    const line = pending.slice(0, at)
    pending = pending.slice(at + 1)
    if (line.trim() === '') continue
    frames.push(JSON.parse(line))
  }
})
child.stderr.on('data', (chunk) => stderrLines.push(String(chunk).trim()))

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
let id = 0
const call = async (method, params = {}) => {
  const mine = ++id
  send({ jsonrpc: '2.0', id: mine, method, params })
  for (let waited = 0; waited < 400; waited++) {
    const found = frames.find(frame => frame.id === mine)
    if (found !== undefined) return found
    await new Promise(r => setTimeout(r, 25))
  }
  throw new Error(`${method} was never answered`)
}

const initialize = await call('initialize', {
  protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'jey-transcript', version: '0' },
})
send({ jsonrpc: '2.0', method: 'notifications/initialized' })
const listed = await call('tools/list')
const answered = await call('tools/call', {
  name: 'jev_check', arguments: { claim: 'this file is a test fixture', evidence: 'it asserts on its own output' },
})
const malformed = await call('tools/call', { name: 'jev_check', arguments: { claim: 'only a claim' } })
const unknown = await call('tools/call', { name: 'jey_execute', arguments: { command: 'anything' } })

// The client hanging up is the disconnect the docs describe; the exit code is the claim.
child.stdin.end()
let exitCode = null
for (let waited = 0; waited < 160; waited++) {
  if (child.exitCode !== null) break
  await new Promise(r => setTimeout(r, 25))
}
exitCode = child.exitCode
child.kill()

const redact = text => String(text).split(configPath).join('<temp>/jey-config.json')

mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({
  note: 'One real stdio session against the MCP server. The frames are the bytes this process '
    + 'put on stdout, verbatim apart from the temporary config path, written here as '
    + '<temp>/jey-config.json.',
  generatedBy: 'node scripts/mcp_stdio_transcript.mjs',
  node: process.version,
  entryPoint: entry,
  config,
  exitCodeAfterClientDisconnected: exitCode,
  stderrLines: stderrLines.map(redact),
  session: {
    initialize,
    toolsListed: listed.result.tools.map(tool => ({ name: tool.name, annotations: tool.annotations })),
    successfulCall: redact(JSON.stringify(answered)),
    malformedArguments: redact(JSON.stringify(malformed)),
    unknownTool: redact(JSON.stringify(unknown)),
  },
  rawFrames: frames.map(redact),
}, null, 2) + '\n', 'utf8')

console.log(`wrote ${out}`)
console.log(`frames on stdout: ${frames.length}; stderr lines: ${stderrLines.length}; exit code after the client hung up: ${exitCode}`)
