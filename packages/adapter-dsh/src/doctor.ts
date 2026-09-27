/**
 * The read-only status/doctor surface (spec §11): what a deployment is configured to do,
 * what the host actually offers, and what the journal says has happened. Nothing here
 * writes, mounts, launches, or sends task state.
 *
 * The point of this module is that "the config was accepted" is not the same claim as
 * "Jey is running": the launcher keeps serving after a refused plugin
 * (`docs/HOST_CONTRACT.md` §13), so the journal's mount row is the only durable evidence
 * that a given process is actually watching.
 *
 * @module
 */
import { ConfigError, loadConfig, scanJournal, type AuditEvent, type Auditable, type JeyConfig } from 'jey-core'
import type { ProviderCapabilities, ProviderIdentity } from 'jey-contracts'
import { probeCapabilities, resolveCredential } from './jey-plugin.ts'

/** The launcher version this repository's host contract was probed at. */
export const PINNED_LAUNCHER = '0.1.7-alpha.1'

export interface HostObservation {
  /** Version string read from the installed `@deepseek-ai/dsh`, or null when unreadable. */
  readonly launcherVersion: string | null
  /** Whether the profile's base bundle composes an approval answerer path, or null if unknown. */
  readonly approvalComposed: boolean | null
  /** Where the two observations above came from, so a reader can judge their freshness. */
  readonly source: string
}

export type ProviderProbe =
  | { readonly attempted: false, readonly reason: string }
  | { readonly attempted: true, readonly ok: true, readonly capabilities: ProviderCapabilities }
  | { readonly attempted: true, readonly ok: false, readonly error: string }

export interface DoctorInput {
  readonly raw: unknown
  readonly host: HostObservation
  readonly journalText: string | null
  readonly probe: ProviderProbe
}

export interface DoctorReport {
  readonly schemaVersion: '1'
  readonly verdict: 'READY' | 'NOT_READY' | 'REFUSED'
  readonly reasons: readonly string[]
  readonly config: {
    readonly accepted: boolean
    readonly mode: string
    readonly providerKind: string
    readonly egressMode: string
    readonly features: Readonly<Record<string, boolean>>
    readonly calibration: { readonly configured: boolean, readonly appliesTo: string | null }
    readonly errors: readonly string[]
  }
  readonly credentials: readonly { readonly reference: string, readonly configured: boolean }[]
  readonly compatibility: { readonly pinned: string, readonly installed: string | null, readonly verdict: 'MATCH' | 'MISMATCH' | 'UNKNOWN' }
  readonly approval: { readonly composed: boolean | null, readonly consequence: string }
  readonly provider: { readonly probed: boolean, readonly reason: string, readonly inference: string, readonly identity: string | null }
  readonly journal: {
    readonly present: boolean
    readonly mounted: boolean
    readonly mountRow: string | null
    readonly decisions: number
    readonly actions: Readonly<Record<string, number>>
    readonly executions: Readonly<Record<string, number>>
    readonly isolated: number
    readonly lastErrors: readonly string[]
  }
}

const countBy = <T extends string>(items: readonly T[]): Record<string, number> => {
  const out: Record<string, number> = {}
  for (const item of items) out[item] = (out[item] ?? 0) + 1
  return out
}

/**
 * Build the report. Pure: every fact arrives in `input`, so a test can hand it a host
 * observation and a journal without booting anything.
 */
export function buildDoctorReport(input: DoctorInput): DoctorReport {
  const raw = input.raw as Partial<JeyConfig> | null
  const approvalChannel = input.host.approvalComposed === true
  const reasons: string[] = []

  let config: JeyConfig | null = null
  const configErrors: string[] = []
  try {
    config = loadConfig(input.raw, probeCapabilities(approvalChannel))
  } catch (e) {
    if (e instanceof ConfigError) configErrors.push(...e.errors.map(issue => `${issue.code}@${issue.path}`))
    else configErrors.push(e instanceof Error ? e.message : String(e))
  }

  const mode = String(raw?.mode ?? 'missing')
  const providerKind = String(raw?.provider?.kind ?? 'missing')
  const egressMode = String(raw?.egress?.mode ?? 'missing')

  if (configErrors.length > 0) reasons.push(`config-refused:${configErrors.join(', ')}`)

  const compatibility = input.host.launcherVersion === null
    ? { pinned: PINNED_LAUNCHER, installed: null, verdict: 'UNKNOWN' } as const
    : {
      pinned: PINNED_LAUNCHER,
      installed: input.host.launcherVersion,
      verdict: input.host.launcherVersion === PINNED_LAUNCHER ? 'MATCH' : 'MISMATCH',
    } as const
  if (compatibility.verdict !== 'MATCH') {
    reasons.push(`launcher-${compatibility.verdict.toLowerCase()}:${String(compatibility.installed)}!=${PINNED_LAUNCHER}`)
  }

  const probe = input.probe
  if (probe.attempted && !probe.ok) reasons.push(`provider-unreachable:${probe.error}`)
  const inference = providerKind === 'mock'
    ? 'SYNTHETIC — 合成应答，不是真实推理'
    : providerKind === 'unconfigured'
      ? 'NOT_CONFIGURED'
      : probe.attempted
        ? probe.ok ? 'PROBED — 服务自报身份见 identity' : 'UNAVAILABLE — 探测失败'
        : 'NOT_RUN — doctor 未探测'

  const scan = input.journalText === null ? null : scanJournal(input.journalText)
  const decisions = (scan?.confirmed ?? []).filter(r => r.kind === 'decision') as readonly AuditEvent[]
  const executions = (scan?.confirmed ?? []).filter(r => r.kind === 'execution')
  const mountRow = (scan?.confirmed ?? []).map(mountedReason).find(r => r !== null) ?? null
  if (input.journalText === null) reasons.push('journal-absent:没有可读的审计文件，装载状态无从判断')
  else if (mountRow === null) reasons.push('journal-unmounted:审计里没有 mount 行，这个进程里的 Jey 可能根本没装载')

  const verdict: DoctorReport['verdict'] = configErrors.length > 0 ? 'REFUSED'
    : compatibility.verdict === 'MISMATCH' || (probe.attempted && !probe.ok) || input.journalText === null || mountRow === null ? 'NOT_READY'
      : 'READY'

  const credentialRefs = [
    ...(config !== null && config.provider.local !== undefined ? [config.provider.local.tokenRef] : []),
    ...(config !== null && config.provider.typesafe !== undefined ? [config.provider.typesafe.credentialRef] : []),
  ]
  const calibration = config?.calibration

  return {
    schemaVersion: '1',
    verdict,
    reasons,
    config: {
      accepted: config !== null,
      mode, providerKind, egressMode,
      features: Object.fromEntries(Object.entries(config?.features ?? {}).map(([k, v]) => [k, v === true])) as Record<string, boolean>,
      calibration: calibration === undefined
        ? { configured: false, appliesTo: null }
        : { configured: true, appliesTo: `${calibration.appliesTo.model.requested}@${calibration.appliesTo.templateDigest}` },
      errors: configErrors,
    },
    // Only "configured or not" — the value and the rest of the environment never leave
    // this function, which is what spec §11 asks for and what the tests below enforce.
    credentials: credentialRefs.map(reference => ({ reference, configured: resolveCredential(reference) !== undefined })),
    compatibility,
    approval: {
      composed: input.host.approvalComposed,
      consequence: input.host.approvalComposed === true
        ? 'ask 会送进宿主的审批接缝，结论从 approval/asked + approval/decided 事件对读回'
        : input.host.approvalComposed === false
          ? '没有审批通道：Jey 把该问的问题直接记成 deny + approval-channel-absent'
          : '通道状态未知：doctor 按"没有通道"这一更严格的一侧配置校验',
    },
    provider: {
      probed: probe.attempted,
      reason: probe.attempted ? 'capabilities 探测已执行' : probe.reason,
      inference,
      identity: probe.attempted && probe.ok ? identityOf(probe.capabilities.provider) : null,
    },
    journal: {
      present: input.journalText !== null,
      mounted: mountRow !== null,
      mountRow,
      decisions: decisions.length,
      actions: countBy(decisions.map(r => String(r.action))),
      executions: countBy(executions.map(r => r.kind === 'execution' ? r.status : 'unknown')),
      isolated: scan?.isolated.length ?? 0,
      lastErrors: [...decisions].reverse()
        .flatMap(r => r.reasonCodes.filter(c => !c.startsWith('no-jey-restriction')).map(c => `${r.action}:${c}`))
        .slice(0, 5),
    },
  }
}

/** The mount row's text, or null when the event is not one. */
function mountedReason(event: Auditable): string | null {
  return event.kind === 'diagnostic' && event.reason.startsWith('mounted:') ? event.reason : null
}

/**
 * What the answering side actually is, from what it reported about itself. `synthetic`
 * is shown first because a mock answering a real deployment's question is the single
 * most important thing for a reader to notice.
 */
function identityOf(provider: ProviderIdentity): string {
  const digest = provider.weightsDigest === null ? 'no-digest' : provider.weightsDigest.slice(0, 12)
  const revision = provider.modelRevision === null ? 'revision-unreported' : provider.modelRevision.slice(0, 12)
  return `${provider.synthetic ? 'SYNTHETIC ' : ''}${provider.kind}:${provider.resolvedModel}@${revision}#${digest}`
}
