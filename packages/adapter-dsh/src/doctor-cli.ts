#!/usr/bin/env node
/**
 * `pnpm --filter jey-adapter-dsh doctor -- --config <file>`: the read-only report.
 *
 * Reads three things and writes none: a Jey config file, the installed launcher's own
 * metadata, and the journal Jey would have appended to. Anything it cannot observe it
 * says it did not observe, which is the whole point of having this command at all — the
 * launcher keeps serving after a refused plugin (docs/HOST_CONTRACT.md §13), so "the
 * command exited 0" only means something when the mount row is in the journal.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig, type JeyConfig } from 'jey-core'
import { buildDoctorReport, PINNED_LAUNCHER, type HostObservation, type ProviderProbe } from './doctor.ts'
import { probeCapabilities, providerFor } from './jey-plugin.ts'

interface Options {
  readonly config: string
  readonly journal: string | null
  readonly home: string
  readonly json: boolean
}

function parseArgs(argv: readonly string[]): Options {
  const state = {
    config: '',
    journal: process.env.JEY_AUDIT_PATH ?? null,
    home: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
    json: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i] as string
    // `pnpm run doctor -- --config …` forwards the bare `--`; npm does too.
    if (a === '--') continue
    if (a === '--json') { state.json = true; continue }
    if (a === '--config' || a === '--journal' || a === '--dsh-home') {
      const value = resolve(argv[i + 1] as string)
      if (a === '--config') state.config = value
      else if (a === '--journal') state.journal = value
      else state.home = value
      i += 1
      continue
    }
    throw new Error(`unknown argument ${a}`)
  }
  if (state.config === '') throw new Error('usage: doctor --config <jey config json> [--journal <jsonl>] [--dsh-home <path>] [--json]')
  return state
}

/**
 * What the installed tree says about itself. Both reads are best-effort: an unreadable
 * path is reported as unobserved rather than assumed to match.
 */
function observeHost(home: string): HostObservation {
  const profiles = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  let launcherVersion: string | null = null
  let approvalComposed: boolean | null = null
  try {
    launcherVersion = String(JSON.parse(readFileSync(join(profiles, 'dsh', 'package.json'), 'utf8')).version)
  } catch { launcherVersion = null }
  try {
    const base = readFileSync(join(profiles, 'dsh-base', 'cordis.patch.yml'), 'utf8')
    approvalComposed = /dsh-user-approval/.test(base)
  } catch { approvalComposed = null }
  return { launcherVersion, approvalComposed, source: profiles }
}

async function probeOf(config: JeyConfig): Promise<ProviderProbe> {
  const kind = config.provider.kind
  if (kind === 'mock' || kind === 'unconfigured') {
    return { attempted: false, reason: kind === 'mock' ? 'mock 是合成应答，探测没有意义' : '未配置提供方' }
  }
  if (kind === 'typesafe') {
    // A cloud probe costs money and needs a key. The gates that require it are recorded
    // as BLOCKED, and this command does not silently make one.
    return { attempted: false, reason: 'NOT_RUN：云端能力探测需要真实调用授权，doctor 不发请求' }
  }
  if (config.egress.mode === 'deny') return { attempted: false, reason: 'egress.mode=deny，连回环探测也不发' }
  const provider = providerFor(config)
  try {
    const capabilities = await provider.capabilities()
    return { attempted: true, ok: true, capabilities }
  } catch (e) {
    return { attempted: true, ok: false, error: e instanceof Error ? e.message : String(e) }
  } finally {
    await provider.close()
  }
}

function render(report: ReturnType<typeof buildDoctorReport>): string {
  const lines = [
    `verdict      ${report.verdict}`,
    `config       ${report.config.accepted ? 'accepted' : 'REFUSED'}`,
    `mode         ${report.config.mode}   provider ${report.config.providerKind}   egress ${report.config.egressMode}`,
    `features     ${JSON.stringify(report.config.features)}`,
    `calibration  ${report.config.calibration.configured ? report.config.calibration.appliesTo : 'not configured'}`,
    ...report.config.errors.map(e => `error        ${e}`),
    `launcher     ${report.compatibility.verdict} pinned ${PINNED_LAUNCHER} / installed ${String(report.compatibility.installed)}`,
    `approval     ${String(report.approval.composed)} — ${report.approval.consequence}`,
    `inference    ${report.provider.inference}${report.provider.identity === null ? '' : ` (${report.provider.identity})`}`,
    `probe        ${report.provider.reason}`,
    ...report.credentials.map(c => `credential   ${c.reference} = ${c.configured ? 'configured' : 'NOT_CONFIGURED'}`),
    `journal      ${report.journal.present ? 'read' : 'absent'} mounted=${String(report.journal.mounted)}`
      + ` decisions=${report.journal.decisions} isolated=${report.journal.isolated}`,
    `actions      ${JSON.stringify(report.journal.actions)}`,
    `executions   ${JSON.stringify(report.journal.executions)}`,
    ...(report.journal.mountRow === null ? [] : [`mount row   ${report.journal.mountRow}`]),
    ...report.journal.lastErrors.map(e => `last         ${e}`),
    ...report.reasons.map(r => `why          ${r}`),
  ]
  return lines.join('\n')
}

async function main(): Promise<number> {
  const options = parseArgs(process.argv.slice(2))
  const raw = JSON.parse(readFileSync(options.config, 'utf8')) as unknown
  const journalText = options.journal !== null && existsSync(options.journal)
    ? readFileSync(options.journal, 'utf8')
    : null
  const host = observeHost(options.home)
  let probe: ProviderProbe = { attempted: false, reason: '配置未被接受，未探测' }
  try {
    probe = await probeOf(loadConfig(raw, probeCapabilities(host.approvalComposed === true)))
  } catch { /* buildDoctorReport reports the refusal and its codes */ }
  const report = buildDoctorReport({ raw, host, journalText, probe })
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${render(report)}\n`)
  return report.verdict === 'READY' ? 0 : 1
}

main().then(code => { process.exitCode = code }, e => {
  process.stderr.write(`doctor: ${e instanceof Error ? e.message : String(e)}\n`)
  process.exitCode = 2
})
