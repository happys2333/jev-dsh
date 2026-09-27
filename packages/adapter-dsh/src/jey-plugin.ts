import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context, Events } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type {
  DecisionAction, DecisionProvider, DecisionRequest, ErrorCode, HostDecision, JsonValue, PolicyDecision, ProviderCapabilities, QuestionOutcome, SnapshotRef,
} from 'jey-contracts'
import {
  AuditJournal, DecisionCoordinator, EMPTY_PROGRESS, activeConstraints, assertSupported, assessmentState, buildSnapshot, calibrationApplies, checkEgress,
  compileAssessment, evaluatePolicy, fitToBudget, isErrorCode, isFresh, loadConfig, mintAuditId, observeCall, pausedPath, publicSnapshot, recordExecution, sha256, shouldBlockDispatch,
  type AuditEvent, type EmitResult, type HostCapabilities, type JeyConfig, type LineSink, type PathIdentity, type ProgressStore, type SnapshotFacts, type StateSection, type TaskConstraint,
} from 'jey-core'
import { MockProvider } from './providers/mock.ts'
import { ExpectedProvider } from './identity.ts'
import { TypesafeProvider } from 'jey-provider-typesafe'
import { LocalProvider } from 'jey-provider-local'

/**
 * Jey as a DSH plugin: the only place in this repository that imports the host.
 *
 * Ordering follows the host contract rather than wishful thinking. `tools/pre-execute`
 * is a waterfall, so the host's own decision is whatever `next()` returns and our action
 * is combined onto it (spec 7.2 table 1). The synchronous `guard()` never touches the
 * network: it reads only facts that already exist, which is also what makes its denial
 * something a later waterfall listener cannot talk past.
 */

/** DSH's `PreToolDecision` and Jey's `HostDecision` are the same four shapes. */
function toPreTool(decision: HostDecision) {
  switch (decision.kind) {
    case 'allow': return { kind: 'allow' } as const
    case 'ask': return decision.reason === undefined ? { kind: 'ask' } as const : { kind: 'ask', reason: decision.reason } as const
    case 'deny': return { kind: 'deny', reason: decision.reason } as const
    case 'cancel': return { kind: 'cancel' } as const
  }
}

function fromPreTool(decision: { readonly kind: 'allow' | 'deny' | 'cancel' | 'ask'; readonly reason?: string }): HostDecision {
  if (decision.kind === 'deny') return { kind: 'deny', reason: decision.reason ?? 'denied by host' }
  if (decision.kind === 'ask') return decision.reason === undefined ? { kind: 'ask' } : { kind: 'ask', reason: decision.reason }
  if (decision.kind === 'cancel') return { kind: 'cancel' }
  return { kind: 'allow' }
}

/**
 * The row for a call that will not dispatch, decided from what we handed back.
 *
 * `not-dispatched` is a refusal Jey raised; `denied-by-host` is the host refusing a call
 * Jey added nothing to. Both used to be recorded by *absence*, which a reader cannot tell
 * apart from an execution row that was never written.
 */
export function refusalOf(
  kind: HostDecision['kind'],
  action: DecisionAction | null,
  reasonCodes: readonly string[],
): { readonly status: 'not-dispatched' | 'denied-by-host' | 'cancelled'; readonly failureCode: string } | null {
  if (kind === 'cancel') return { status: 'cancelled', failureCode: action === 'cancel' ? 'jey-cancelled' : 'caller-cancelled' }
  if (kind !== 'deny') return null
  if (action !== 'deny') return { status: 'denied-by-host', failureCode: 'host-denied' }
  if (reasonCodes.includes('approval-channel-absent')) return { status: 'not-dispatched', failureCode: 'approval-channel-absent' }
  if (reasonCodes.includes('audit-blocked')) return { status: 'not-dispatched', failureCode: 'audit-blocked' }
  return { status: 'not-dispatched', failureCode: 'jey-denied' }
}

/**
 * What the host finally did with a call, given the approval outcome (when there was one)
 * and the settled result.
 *
 * A `default` branch is deliberate: if the host's approval vocabulary ever grows, the
 * new value lands as a denial with its name in the failure code, never as `succeeded`.
 */
export function executionStatusOf(
  approval: ApprovalOutcome | undefined,
  isError: boolean,
): { readonly status: 'succeeded' | 'failed' | 'cancelled' | 'denied-by-host'; readonly failureCode: string | null } {
  if (approval === undefined || approval === 'allowed-once') {
    return { status: isError ? 'failed' : 'succeeded', failureCode: isError ? 'tool-reported-error' : null }
  }
  if (approval === 'cancelled') return { status: 'cancelled', failureCode: 'approval-cancelled' }
  if (approval === 'rejected') return { status: 'denied-by-host', failureCode: 'approval-rejected' }
  if (approval === 'unavailable') return { status: 'denied-by-host', failureCode: 'approval-unavailable' }
  return { status: 'denied-by-host', failureCode: `approval-outcome-unknown:${String(approval)}` }
}

/** How much of one user message is carried as evidence before it is reported as cut. */
const USER_TEXT_LIMIT = 4000

/**
 * Collect text blocks out of a host message without assuming its exact shape, and say
 * whether any of it was lost. A silent `slice` here once dropped a constraint that sat
 * at the end of a long message while the decision went out as if nothing were missing.
 */
function textOf(value: unknown, limit = USER_TEXT_LIMIT): { readonly text: string; readonly truncated: boolean } {
  const parts: string[] = []
  let oversized = false
  const walk = (node: unknown): void => {
    if (parts.join(' ').length >= limit || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    const record = node as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    Object.values(record).forEach(walk)
  }
  walk(value)
  const joined = parts.join(' ')
  oversized = joined.length > limit
  return { text: joined.slice(0, limit), truncated: oversized }
}

/**
 * The one place that turns a host execution into a progress path identity. Both the
 * synchronous guard and the post-result update go through here: they disagreed once
 * (the guard searched for a tool name inside a digest key), and a pause that is written
 * under one identity and read under another is a pause that never happens.
 *
 * `agent.id` is DSH's `SessionId` — an agent handle *is* its session identity, so there
 * is no separate session field to read here.
 */
interface Executable {
  readonly name: string
  readonly arguments: unknown
  readonly agent?: { readonly id: string } | undefined
  readonly rootCallId?: string | undefined
}

/**
 * The one expression that decides which scope an execution belongs to. Scope state, the
 * progress path key and the snapshot identity all go through it, so the store a pause is
 * written to and the store a denial reads from cannot end up being different things.
 */
function scopeKeyOf(exec: { readonly agent?: { readonly id: string } | undefined }): string {
  return exec.agent?.id ?? 'agentless'
}

function pathIdentity(exec: Executable): PathIdentity {
  return {
    scopeKey: scopeKeyOf(exec),
    toolName: exec.name,
    normalizedArguments: exec.arguments as JsonValue,
  }
}

const hardRulesFor = (progress: ProgressStore, exec: Executable): string[] => {
  const paused = pausedPath(progress, pathIdentity(exec))
  return paused === undefined ? [] : [`path-paused:${paused.fingerprint.slice(0, 16)}`]
}

export interface FileSinkOptions {
  readonly path: string
  readonly maxFileBytes: number
}

/**
 * Append-only diagnostics. Rotation renames rather than truncates so a concurrent
 * reader is not pulled out from under, and a failed write surfaces through the journal's
 * counters instead of being swallowed.
 */
export function fileLineSink(options: FileSinkOptions): LineSink {
  let known = 0
  const onDisk = (): number => {
    try {
      return statSync(options.path).size
    } catch {
      return 0
    }
  }
  return {
    writeLine(line: string): void {
      if (known === 0) known = onDisk()
      const cost = Buffer.byteLength(line, 'utf8') + 1
      if (known + cost > options.maxFileBytes) {
        try {
          renameSync(options.path, `${options.path}.${Date.now()}.old`)
        } catch {
          /* nothing to rotate yet */
        }
        known = 0
      }
      mkdirSync(dirname(options.path), { recursive: true })
      appendFileSync(options.path, `${line}\n`, 'utf8')
      known += cost
    },
  }
}

const stderrSink: LineSink = {
  writeLine(line) {
    process.stderr.write(`jey-audit ${line}\n`)
  },
}

/**
 * Where diagnostics go when nothing was injected. An explicit path wins over stderr
 * because a plugin that writes to a hostile terminal's stderr is not really auditing
 * anything. The path comes from the environment, never from a model-visible setting.
 */
function defaultSink(config: JeyConfig): LineSink {
  const path = process.env.JEY_AUDIT_PATH
  if (path === undefined || path === '') return stderrSink
  return fileLineSink({ path, maxFileBytes: config.audit.maxFileBytes })
}

export interface JeyMountDeps {
  readonly provider: DecisionProvider
  readonly audit?: LineSink
  readonly now?: () => number
}

export interface JeyRuntime {
  readonly config: JeyConfig
  readonly generation: number
  records: readonly AuditEvent[]
  progress: ProgressStore
  /** Set once an audit write fails while the configuration requires auditing. */
  auditBlocked: boolean
  dispose(): Promise<void>
  close(): void
}

/** Collected facts about what one scope is trying to do, and how often it changed. */
interface ScopeTask {
  readonly initialGoal: string | null
  readonly currentSubgoal: string | null
  /**
   * Trusted, attributable limits only. Nothing parses user prose into a constraint here:
   * a model-readable summary is not an enforceable rule, and a guessed one is worse than
   * an empty list marked `requirementsUnavailable`. DSH surfaces no structured policy
   * source at present, so this stays empty and that flag stays true.
   */
  readonly constraints: readonly TaskConstraint[]
  readonly latestRevisionEvent: string | null
  readonly version: number
  readonly requirementsUnavailable: boolean
}

/**
 * Everything that belongs to one session-and-agent, kept apart so two of them running at
 * once cannot read each other's goal, history or failure counts.
 *
 * DSH's `Agent` is `{ id: SessionId }` — an agent handle *is* session-backed — so one key
 * serves both roles here, and there is no parent-session field on an execution to derive
 * a shared budget from. That limitation is recorded in docs, not worked around by
 * guessing at a lineage the host does not expose.
 */
interface ScopeState {
  position: { readonly turn: number; readonly step: number }
  sequence: number
  task: ScopeTask
  readonly conversation: { readonly role: string; readonly text: string }[]
  readonly recentResults: { readonly toolName: string; readonly status: string }[]
}

const newScope = (): ScopeState => ({
  position: { turn: 0, step: 0 },
  sequence: 0,
  task: {
    initialGoal: null, currentSubgoal: null, constraints: [], latestRevisionEvent: null,
    version: 0, requirementsUnavailable: true,
  },
  conversation: [],
  recentResults: [],
})

/**
 * Build the decision machinery and attach it to a live DSH context. Exported separately
 * from {@link apply} so a host test can supply a provider and a captured audit sink;
 * `apply` itself cannot, because cordis only ever passes it the config block.
 */
/** One plugin instance is one generation, so a hot-swap invalidates everything in flight. */
let generationCounter = 0

/**
 * The host facts this build was probed against, in one place so the runtime mount and
 * the read-only doctor cannot drift into disagreeing about what the host offers.
 * `approvalChannel` is the only part observable per-process; the other two come from
 * `docs/HOST_CONTRACT.md` and are asserted there, not guessed here.
 */
export function probeCapabilities(approvalChannel: boolean): HostCapabilities {
  return { approvalChannel, scopedRestrict: true, postExecuteWaterfall: true }
}

export function mountJey(ctx: Context, raw: unknown, deps: JeyMountDeps): JeyRuntime {
  const now = deps.now ?? (() => Date.now())
  const capabilities = (): HostCapabilities => probeCapabilities(
    // The host resolves an `ask` through this seam opportunistically; a deployment that
    // composes no ApprovalService degrades to denial, so claiming an approval channel we
    // cannot see would be a lie about a protection.
    ctx.get('approval') !== undefined,
  )

  const config = loadConfig(raw, capabilities())
  const generation = ++generationCounter
  const policyVersion = `sha256:${sha256(JSON.stringify({ config, generation }))}`
  const journal = new AuditJournal(deps.audit ?? defaultSink(config), {
    maxRetainedEvents: config.audit.retainedEvents,
    maxLineBytes: config.audit.maxFileBytes,
    now,
  })
  const coordinator = new DecisionCoordinator(deps.provider, {
    limits: {
      maxConcurrent: config.limits.maxConcurrent,
      maxQueue: config.limits.maxQueue,
      deadlineMs: config.limits.deadlineMs,
      perTurnCalls: config.limits.perTurnCalls,
      perSessionCalls: config.limits.perSessionCalls,
      // Fairness, not a user knob: one session may not queue more than the host can run
      // at once, otherwise a single chatty agent starves every other one.
      maxQueuePerSession: Math.max(1, config.limits.maxConcurrent),
    },
    now,
    onDiagnostic: event => {
      journal.emit({ kind: 'diagnostic', auditId: mintAuditId(), requestId: event.key, sessionId: '', reason: event.kind, at: now() })
    },
  })

  const records: AuditEvent[] = []
  // Argument digests may only be published where a key makes them non-reversible; without
  // one, `publicSnapshot` drops them. The key comes from the environment and never from
  // model-visible config, because a key the observed thing can set is not a key.
  const auditKey = process.env.JEY_AUDIT_KEY ?? null
  /**
   * One entry per session-and-agent. Sharing these across scopes was R03: with two
   * agents live, whichever spoke last became the other one's goal.
   */
  const scopes = new Map<string, ScopeState>()
  // Deliberately global: any advertised-tool change anywhere raises the digest, so an
  // unrelated agent's catalog change can only ever invalidate a pending decision, never
  // wrongly confirm one. Per-scope digests need a host identity we cannot see at assemble
  // time; that is recorded as a known gap rather than papered over.
  let catalogDigest = `sha256:${sha256('[]')}`
  const HISTORY_CAP = 40

  const scopeFor = (key: string): ScopeState => {
    const known = scopes.get(key)
    if (known !== undefined) return known
    const fresh = newScope()
    scopes.set(key, fresh)
    return fresh
  }

  const runtime = {
    config,
    generation,
    records,
    progress: EMPTY_PROGRESS,
    dispose: async () => coordinator.close(),
    // `close` is a hoisted function declaration further down; it refers to listeners that
    // do not exist yet here, which is fine because it only ever runs on teardown.
    close,
    auditBlocked: false,
  }

  /**
   * The snapshot facts for one call, read from live scope state at the moment of the
   * call. The captured ref and the apply-time re-check both go through here, so a stale
   * decision cannot survive because the two sides computed identity differently — which
   * is exactly what happened when the caller passed the captured ref back in.
   */
  function factsFor(args: {
    readonly scopeKey: string
    readonly toolName: string
    readonly arguments: JsonValue
    readonly rootCallId: string | null
    readonly truncated: readonly string[]
  }): SnapshotFacts {
    const scope = scopeFor(args.scopeKey)
    const active = activeConstraints(scope.task).map(c => c.text)
    return {
      // DSH's `Agent` is `{ id: SessionId }` — an agent handle *is* session-backed — so
      // one key serves both fields here. A shared parent budget would need a parent link
      // the execution does not carry; recorded as a gap, not guessed at.
      sessionId: args.scopeKey,
      agentId: args.scopeKey,
      turn: scope.position.turn,
      step: scope.position.step,
      generation,
      policyVersion,
      taskVersion: scope.task.version,
      task: { ...scope.task },
      catalog: [{ name: args.toolName, schemaDigest: catalogDigest }],
      call: {
        toolName: args.toolName,
        frozenArguments: args.arguments,
        executionToken: args.rootCallId ?? 'unknown-call',
        observationSequence: scope.sequence,
      },
      recentResults: scope.recentResults.slice(-5),
      observationSequence: scope.sequence,
      truncated: args.truncated,
    }
  }

  function snapshot(args: {
    readonly scopeKey: string
    readonly toolName: string
    readonly arguments: JsonValue
    readonly rootCallId: string | null
    readonly approvalChannel: boolean
  }): { readonly ref: SnapshotRef; readonly request: DecisionRequest; readonly fields: readonly string[]; readonly truncated: readonly string[]; readonly neededBytes: number | null } {
    const scope = scopeFor(args.scopeKey)
    const active = activeConstraints(scope.task).map(c => c.text)
    // §5.2 order: hard policy and this call first, then recent results, then conversation.
    // Cutting happens at JSON boundaries and every removal is recorded on the snapshot.
    const sections: StateSection[] = [
      { id: 'policy', kind: 'policy', value: { mode: config.mode, constraints: active } },
      { id: 'call', kind: 'current-call', value: assessmentState({ toolName: args.toolName, frozenArguments: args.arguments, goal: scope.task.currentSubgoal, constraints: active }) },
      { id: 'results', kind: 'recent-result', value: scope.recentResults.slice(-5) },
      { id: 'chat', kind: 'conversation', value: scope.conversation.slice(-12) },
    ]
    const fit = fitToBudget(sections, config.limits.maxStateBytes)
    const built = buildSnapshot(factsFor({
      scopeKey: args.scopeKey,
      toolName: args.toolName,
      arguments: args.arguments,
      rootCallId: args.rootCallId,
      truncated: fit.ok ? fit.omissions.map(o => o.path) : [`insufficient:${fit.code}`],
    }))
    const request: DecisionRequest = {
      schemaVersion: '1',
      requestId: `req_${randomUUID()}`,
      purpose: 'tool-assessment',
      snapshot: built.ref,
      state: fit.ok ? fit.state : {},
      questions: compileAssessment(),
      budget: { maxElapsedMs: config.limits.deadlineMs, maxInputBytes: config.limits.maxStateBytes },
    }
    return {
      ref: built.ref,
      request,
      fields: fit.ok ? Object.keys(fit.state) : [],
      truncated: built.facts.truncated,
      neededBytes: fit.ok ? null : fit.neededBytes,
    }
  }

  /**
   * What happened, as one immutable row. `observation` is null on every path that never
   * reached a provider, which is exactly the case a fabricated "answer" would otherwise
   * disguise. The snapshot is published through `publicSnapshot`, so an argument digest
   * only reaches the log when a key makes it non-reversible.
   */
  function record(input: {
    readonly request: DecisionRequest
    readonly ref: SnapshotRef
    readonly reasonCodes: readonly string[]
    readonly action: AuditEvent['action']
    readonly hostDecision: HostDecision | null
    readonly observation: { providerKind: AuditEvent['providerKind']; model: string; templateDigest: string; synthetic: boolean; egress: boolean; statuses: AuditEvent['questionStatuses']; timing: AuditEvent['timing'] } | null
    readonly stale?: boolean
    readonly truncatedPaths: readonly string[]
  }): EmitResult {
    const event: AuditEvent = {
      kind: 'decision',
      auditId: mintAuditId(),
      requestId: input.request.requestId,
      sessionId: input.ref.sessionId,
      agentId: input.ref.agentId,
      providerKind: input.observation?.providerKind ?? 'mock',
      synthetic: input.observation?.synthetic ?? true,
      resolvedModel: input.observation?.model ?? 'not-called',
      templateDigest: input.observation?.templateDigest ?? 'sha256:none',
      snapshot: publicSnapshot(input.ref, auditKey),
      timing: input.observation?.timing ?? { queueMs: 0, inferenceMs: 0, totalMs: 0 },
      questionStatuses: input.observation?.statuses ?? input.request.questions.map(q => ({ id: q.id, status: 'error' as const })),
      action: input.action,
      reasonCodes: [...input.reasonCodes],
      hostDecision: input.hostDecision?.kind ?? null,
      // Always null here, and honestly so: this row is written before dispatch. What the
      // host finally did arrives as its own `execution` row, keyed by requestId.
      execution: null,
      failureCode: null,
      egressOccurred: input.observation?.egress ?? false,
      stale: input.stale ?? false,
      truncatedPaths: input.truncatedPaths,
      at: now(),
    }
    records.push(event)
    // The in-memory view is what a `doctor` reads, so it has to obey the same bound as
    // the journal; an unbounded array here grew for the lifetime of the host process.
    while (records.length > config.audit.retainedEvents) records.shift()
    return journal.emit(event)
  }

  const hardRules = (exec: Executable): string[] => hardRulesFor(runtime.progress, exec)

  /**
   * Record the outcome and produce the decision to hand back. When the configuration
   * requires an audit row and this call's row did not land, the call is refused *now* —
   * waiting for the next call to notice the flag would let one unaudited action through,
   * which is precisely what a fail-closed setting is supposed to prevent.
   */
  function conclude(
    input: Parameters<typeof record>[0],
    decision: HostDecision,
    approvalChannel: boolean,
    exec: Executable & { readonly rootCallId?: string | null },
  ): HostDecision {
    const written = record(input)
    if (!shouldBlockDispatch(config.audit.onFailure, written)) {
      // Register the call for its outcome row here rather than at one call site, so every
      // path that ends a decision — hard rule, egress refusal, provider error, stale
      // snapshot, or a normal policy outcome — leaves the same kind of record.
      trackDispatch(exec, input.request, decision, input.action, input.reasonCodes)
      return decision
    }
    runtime.auditBlocked = true
    // No execution row on this path: the decision row it would correlate to never landed,
    // and a row pointing at an unheard-of requestId would be an invention.
    const reason = `jey: audit required but this decision could not be written (${written.reason})`
    return approvalChannel ? { kind: 'ask', reason } : { kind: 'deny', reason }
  }

  const errorOutcomes = (request: DecisionRequest, code: ErrorCode): readonly QuestionOutcome[] =>
    request.questions.map(q => ({ id: q.id, status: 'error' as const, code, retryable: false }))

  let declaredCapabilities: ProviderCapabilities | null | undefined
  let capabilitiesInFlight: Promise<{ readonly ok: true; readonly value: ProviderCapabilities }
    | { readonly ok: false; readonly code: ErrorCode }> | null = null

  /**
   * Why this request must not be sent, or null when it may. The provider's own error code
   * survives the capability probe: flattening `LOCAL_NOT_READY`, `AUTH` or
   * `EGRESS_DENIED` into one generic refusal would lose exactly the distinction an
   * operator needs. A failed probe is not cached — a service that comes back is re-asked.
   */
  async function capabilityRefusal(
    request: DecisionRequest,
  ): Promise<{ readonly code: ErrorCode; readonly reason: string } | null> {
    if (request.questions.length > config.limits.maxQuestions) {
      return {
        code: 'UNSUPPORTED_CAPABILITY',
        reason: `local-limit:maxQuestions=${config.limits.maxQuestions}`,
      }
    }
    if (declaredCapabilities === undefined) {
      capabilitiesInFlight ??= deps.provider.capabilities().then(
        value => ({ ok: true as const, value }),
        (error: unknown) => ({
          ok: false as const,
          code: error instanceof Error && 'code' in error && isErrorCode((error as { code: unknown }).code)
            ? (error as { code: ErrorCode }).code
            : 'INVALID_RESPONSE' as const,
        }),
      )
      const probed = await capabilitiesInFlight
      capabilitiesInFlight = null
      if (!probed.ok) return { code: probed.code, reason: `provider:${probed.code}` }
      declaredCapabilities = probed.value
    }
    const declared = declaredCapabilities
    if (declared === null) return { code: 'INVALID_RESPONSE', reason: 'provider:INVALID_RESPONSE' }
    try {
      assertSupported(request.questions, declared, Buffer.byteLength(JSON.stringify(request.state), 'utf8'))
    } catch (error) {
      return { code: 'UNSUPPORTED_CAPABILITY', reason: `capability:${error instanceof Error ? error.message : 'rejected'}` }
    }
    return null
  }

  const onAssemble: Events['system-prompt/assemble'] = async (assembly, _context, next) => {
    const result = await next()
    catalogDigest = `sha256:${sha256(JSON.stringify(result.tools))}`
    return result
  }

  /**
   * The user input that will actually reach the model for this step is whatever
   * {@link next} admits, not the last thing that appeared in the inbox. Recording the
   * admitted set is what makes a second-turn "continue" keep the first turn's goal.
   */
  const onPreStep: Events['agent/pre-step'] = async (payload, next) => {
    const decision = await next()
    const scope = scopeFor(payload.agent.id)
    scope.position = { turn: payload.turn, step: payload.step }
    scope.sequence += 1
    if (decision.kind !== 'enter') return decision
    for (const message of decision.messages) reviseTask(scope, message, payload.turn, payload.step)
    return decision
  }

  function reviseTask(scope: ScopeState, message: unknown, turn: number, step: number): void {
    const read = textOf(message, USER_TEXT_LIMIT)
    if (read.text.length === 0) return
    scope.conversation.push({ role: 'user', text: read.text })
    if (scope.conversation.length > HISTORY_CAP) scope.conversation.shift()
    scope.task = {
      initialGoal: scope.task.initialGoal ?? read.text,
      currentSubgoal: read.text,
      constraints: scope.task.constraints,
      latestRevisionEvent: `turn:${turn}/step:${step}${read.truncated ? ':truncated' : ''}`,
      version: scope.task.version + 1,
      // A cut message or an absent structured source means the layer cannot see the
      // user's limits. That is reported as unknown, never as "no limits were set".
      requirementsUnavailable: read.truncated || scope.task.constraints.length === 0,
    }
  }

  const onPreExecute: Events['tools/pre-execute'] = async (exec, next) => {
    const host = fromPreTool(await next())
    if (config.mode === 'off' || exec.signal.aborted) return toPreTool(host)
    // A feature that is switched off does nothing at all: no provider call, no
    // observation, no audit row. The previous guard for this was `A && !A`, which could
    // never be true, so `toolAssessment: false` still spent a model call on every tool.
    if (config.features.toolAssessment !== true) return toPreTool(host)

    const scopeKey = scopeKeyOf(exec)
    const approvalChannel = exec.agent !== undefined && ctx.get('approval') !== undefined
    const { ref, request, fields, truncated, neededBytes } = snapshot({
      scopeKey,
      toolName: exec.name,
      arguments: exec.arguments as JsonValue,
      rootCallId: exec.rootCallId ?? null,
      approvalChannel,
    })
    const violations = hardRules(exec)

    if (neededBytes !== null) {
      // The call's own arguments did not fit. Trimming them and answering anyway would
      // be a verdict about text the provider never saw (spec 5.2).
      const policy = evaluatePolicy({ mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, 'INSUFFICIENT_CONTEXT') })
      return toPreTool(conclude(
        { request, ref, truncatedPaths: truncated, reasonCodes: [`insufficient-context:${neededBytes}`, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null },
        policy.combined, approvalChannel, exec,
      ))
    }

    if (violations.length > 0) {
      // Deterministic rules hold regardless of mode, including shadow. `shadow` means a
      // model's opinion is observational only; a recorded fact about what already
      // happened needs no model and is not an opinion, and the synchronous guard denies
      // it too, so the two layers stay consistent instead of contradicting each other.
      const decision: HostDecision = host.kind === 'deny' || host.kind === 'cancel'
        ? host
        : { kind: 'deny', reason: `jey: ${violations.join(', ')}` }
      const policy = evaluatePolicy({ mode: config.mode, host, hardRuleViolations: violations, approvalChannel })
      record({ request, ref, truncatedPaths: truncated, reasonCodes: policy.reasonCodes, action: 'deny', hostDecision: host, observation: null })
      trackDispatch(exec, request, decision, 'deny', policy.reasonCodes)
      return toPreTool(decision)
    }

    if (runtime.auditBlocked) {
      const reason = 'jey: audit required but unwritable'
      record({ request, ref, truncatedPaths: truncated, reasonCodes: ['audit-blocked'], action: 'deny', hostDecision: host, observation: null })
      trackDispatch(exec, request, { kind: 'deny', reason }, 'deny', ['audit-blocked'])
      return { kind: 'deny', reason }
    }

    // Egress governs bytes that leave the process. A mock provider answers from memory, so
    // running its answers past an origin allowlist would be guarding nothing — and would
    // make the offline engineering gates impossible to reach at all.
    const touchesNetwork = config.provider.kind === 'local' || config.provider.kind === 'typesafe'
    const egress = touchesNetwork
      ? checkEgress(
        {
          mode: config.egress.mode,
          localOrigins: config.egress.allowedOrigins ?? [],
          allowedPurposes: config.egress.allowedPurposes ?? [],
          destinations: config.egress.destinations ?? [],
        },
        {
          providerKind: config.provider.kind,
          destinationId: config.egress.destinations?.find(d => d.endpoint === config.provider.typesafe?.endpointOrigin)?.id ?? null,
          endpoint: config.provider.local?.endpoint ?? config.provider.typesafe?.endpointOrigin ?? null,
          purpose: request.purpose,
          fields,
          credentialConfigured: config.provider.typesafe?.credentialRef !== undefined || config.provider.local?.tokenRef !== undefined,
          providerExplicitlySelected: true,
        },
      )
      : ({ allowed: true, destinationId: 'in-process' } as const)
    if (!egress.allowed) {
      const policy = evaluatePolicy({
        mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, 'EGRESS_DENIED'),
      })
      return toPreTool(conclude(
        { request, ref, truncatedPaths: truncated, reasonCodes: [...egress.reasons, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null },
        policy.combined, approvalChannel, exec,
      ))
    }

    // Find out what this provider can answer before spending a request on it. Both the
    // local cap and the provider's declared ceiling were decoration until here.
    const refusal = await capabilityRefusal(request)
    if (refusal !== null) {
      const policy = evaluatePolicy({
        mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, refusal.code),
      })
      return toPreTool(conclude(
        { request, ref, truncatedPaths: truncated, reasonCodes: [refusal.reason, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null },
        policy.combined, approvalChannel, exec,
      ))
    }

    const outcome = await coordinator.submit(request, { signal: exec.signal })
    if (outcome.kind !== 'response') {
      const code: ErrorCode = outcome.kind === 'failed'
        ? (outcome.code === 'PROVIDER_ERROR' ? 'INVALID_RESPONSE' : outcome.code)
        : outcome.kind === 'cancelled' ? 'CANCELLED' : 'TIMEOUT'
      const policy = evaluatePolicy({ mode: config.mode, host, approvalChannel, outcomes: errorOutcomes(request, code) })
      const why = outcome.kind === 'failed' ? `provider:${outcome.code}` : `coordinator:${outcome.kind}`
      return toPreTool(conclude(
        { request, ref, truncatedPaths: truncated, reasonCodes: [why, ...policy.reasonCodes], action: policy.action, hostDecision: host, observation: null },
        policy.combined, approvalChannel, exec,
      ))
    }

    // What the state looks like *now*, from the same code that built the captured ref.
    // Passing the captured ref back in — as this did — compares a snapshot with itself
    // and can only ever answer "fresh".
    const current = buildSnapshot(factsFor({
      scopeKey,
      toolName: exec.name,
      arguments: exec.arguments as JsonValue,
      rootCallId: exec.rootCallId ?? null,
      truncated,
    })).ref
    const fresh = isFresh(ref, current)
    const response = outcome.response
    // A calibration block is evidence about one model/template/task. Comparing it with the
    // identity that answered this very request is what stops "a file exists on disk" from
    // upgrading raw probabilities into a calibrated denial (§6.4).
    const calibration = config.calibration
    const calibrationReasons = calibration === undefined
      ? []
      : calibrationApplies(
        { id: calibration.id, model: calibration.appliesTo.model, templateDigest: calibration.appliesTo.templateDigest, task: calibration.appliesTo.task },
        response.provider, request.purpose, response.outcomes,
      )
    const calibrated = calibration !== undefined && calibrationReasons.length === 0
    // An unusable calibration must be visible in the record, not silently ignored: the
    // operator needs to know why a configured deny threshold had no effect.
    const calibrationNotes = calibration !== undefined && !calibrated
      ? calibrationReasons.map(r => `calibration-unapplied:${r}`)
      : []
    const policy = evaluatePolicy({
      mode: config.mode,
      host,
      approvalChannel,
      hardRuleViolations: [],
      outcomes: response.outcomes,
      snapshotFresh: fresh,
      calibrationAvailable: calibrated,
      ...(calibrated ? {
        thresholds: {
          conflictAskAtOrAbove: calibration.conflictAskAtOrAbove,
          conflictDenyAtOrAbove: calibration.conflictDenyAtOrAbove,
          goalBelow: calibration.goalBelow,
          evidenceBelow: calibration.evidenceBelow,
        },
      } : {}),
    })
    const observation = {
      providerKind: response.provider.kind,
      model: response.provider.resolvedModel,
      templateDigest: response.provider.templateDigest,
      synthetic: response.provider.synthetic,
      egress: response.egress.occurred,
      statuses: response.outcomes.map(o => ({ id: o.id, status: o.status })),
      timing: response.timing,
    }

    const applied: PolicyDecision = {
      action: policy.action,
      reasonCodes: policy.reasonCodes,
      requiredQuestionIds: request.questions.map(q => q.id),
      observationRequestId: request.requestId,
      appliesTo: current,
    }
    // Synchronous, single-shot: the freshness re-check and the consumption of the
    // decision happen with no await between them (spec 10.1).
    const resolution = outcome.application.apply(current, host, applied)
    if (resolution.kind === 'stale') {
      const fallback: HostDecision = approvalChannel
        ? { kind: 'ask', reason: 'jey: snapshot stale' }
        : { kind: 'deny', reason: 'jey: snapshot stale' }
      return toPreTool(conclude({
        request, ref, truncatedPaths: truncated, reasonCodes: ['stale-snapshot', ...policy.reasonCodes, ...calibrationNotes],
        action: policy.action, hostDecision: host, observation, stale: true,
      }, host.kind === 'deny' || host.kind === 'cancel' ? host : fallback, approvalChannel, exec))
    }
    if (resolution.kind === 'already-applied') {
      return toPreTool(conclude({
        request, ref, truncatedPaths: truncated, reasonCodes: ['already-applied'],
        action: 'abstain', hostDecision: host, observation,
      }, host, approvalChannel, exec))
    }
    return toPreTool(conclude({
      request, ref, truncatedPaths: truncated, reasonCodes: [...policy.reasonCodes, ...calibrationNotes],
      action: policy.action, hostDecision: host, observation,
    }, resolution.decision, approvalChannel, exec))
  }

  /**
   * Decisions that reached the point of dispatch, awaiting their outcome. Bounded
   * because a long-running host must not accumulate one entry per call forever; the
   * oldest are dropped, and a dropped entry simply means that call has no execution row.
   */
  const dispatched = new Map<string, {
    readonly requestId: string
    readonly sessionId: string
    readonly agentId: string
    readonly toolName: string
    readonly action: DecisionAction | null
    readonly refused: ReturnType<typeof refusalOf>
  }>()
  const DISPATCH_CAP = 256

  /**
   * Remember one key until the cap is reached, then drop the oldest. A host that runs
   * for days must not grow a side table per call, and a dropped entry only costs one
   * execution row's detail — never a decision.
   */
  function remember<K, V>(store: Map<K, V>, key: K, value: V): void {
    store.set(key, value)
    while (store.size > DISPATCH_CAP) {
      const oldest = store.keys().next()
      if (oldest.done === true) break
      store.delete(oldest.value)
    }
  }

  /**
   * Approval outcomes, keyed by the exact call the host put the question about.
   *
   * Jey never runs an approval channel of its own: it returns `ask` and the host's tools
   * pipeline resolves it through `ctx.get('approval')`. `tools/result` fires either way,
   * so without this a human "no" and a tool crash land as the same row, and §11 asks for
   * what actually happened. The host's durable `approval/asked` + `approval/decided` pair
   * is the supported source, and `callId` is the only key it shares with an execution.
   */
  const askedByApproval = new Map<string, string>()
  const approvalOutcomes = new Map<string, ApprovalOutcome>()

  const sessionOff = ctx.on('session/event', (_session, event) => {
    if (event.type === 'approval/asked') {
      const callId = event.data.callId
      if (typeof callId === 'string') remember(askedByApproval, event.data.id, callId)
      return
    }
    if (event.type === 'approval/decided') {
      const callId = askedByApproval.get(event.data.id)
      if (callId !== undefined) remember(approvalOutcomes, callId, event.data.outcome)
    }
  })

  function takeApprovalOutcome(exec: { readonly callId?: string | null }): ApprovalOutcome | undefined {
    const callId = exec.callId
    if (typeof callId !== 'string') return undefined
    const outcome = approvalOutcomes.get(callId)
    approvalOutcomes.delete(callId)
    return outcome
  }

  /**
   * Register the call so its settled result can be published as its own row — including
   * calls that were refused, because "there is no row" is otherwise the only place a
   * reader can see that nothing ran, and it is indistinguishable from a dropped entry.
   */
  function trackDispatch(
    exec: Executable & { readonly rootCallId?: string | null },
    request: DecisionRequest,
    decision: HostDecision,
    action: DecisionAction | null,
    reasonCodes: readonly string[],
  ): void {
    if (exec.rootCallId === undefined || exec.rootCallId === null) return
    remember(dispatched, exec.rootCallId, {
      requestId: request.requestId,
      sessionId: scopeKeyOf(exec),
      agentId: scopeKeyOf(exec),
      toolName: exec.name,
      action,
      refused: refusalOf(decision.kind, action, reasonCodes),
    })
  }

  // Network-free by construction: nothing here may await, so it can only speak about
  // facts the plugin already holds.
  const guardOff = ctx.tools.guard(execution => {
    // A journal the configuration requires and cannot write is a reason not to run
    // something, and the guard is the last gate before the body.
    if (runtime.auditBlocked) return 'jey: audit required but unwritable'
    const violations = hardRules(execution)
    return violations.length > 0 ? `jey: ${violations.join(', ')}` : undefined
  })

  const resultOff = ctx.on('tools/result', (exec, result) => {
    const scope = scopeFor(scopeKeyOf(exec))
    scope.sequence += 1
    scope.recentResults.push({ toolName: exec.name, status: result.isError ? 'failed' : 'succeeded' })
    if (scope.recentResults.length > HISTORY_CAP) scope.recentResults.shift()
    const callId = exec.rootCallId ?? null
    const pending = callId === null ? undefined : dispatched.get(callId)
    if (callId !== null && pending !== undefined) {
      dispatched.delete(callId)
      const outcome = takeApprovalOutcome(exec)
      // Known limitation, stated rather than guessed around: a refusal from the sandbox or
      // another plugin arrives here as nothing but an error result, so it is recorded as
      // `failed`. Only outcomes the host publishes as durable session events are relabelled.
      const execution = pending.refused ?? executionStatusOf(outcome, result.isError)
      journal.emit(recordExecution({
        requestId: pending.requestId,
        sessionId: pending.sessionId,
        agentId: pending.agentId,
        toolName: exec.name,
        status: execution.status,
        appliedAction: pending.action,
        failureCode: execution.failureCode,
        at: now(),
      }))
    }
    runtime.progress = observeCall(runtime.progress, {
      ...pathIdentity(exec),
      status: result.isError ? 'failure' : 'success',
      deterministicError: null,
      // DSH exposes no resource-version signal on a settled result, so a repeat is
      // judged on tool and arguments alone. Claiming `{}` were "no change observed"
      // would be a guess about facts the host never offered.
      resourceVersions: {},
      rootCallId: exec.rootCallId ?? null,
      // Likewise nothing here identifies a status poll; a repeated failing call counts
      // as a repeated failing call.
      isPoll: false,
      observationSequence: scope.sequence,
    }, {
      maxIdenticalFailures: config.limits.maxIdenticalFailures,
      pollBudget: config.limits.pollBudget,
    }).store
  })

  const disposers = [
    ctx.on('system-prompt/assemble', onAssemble),
    ctx.on('agent/pre-step', onPreStep),
    ctx.on('tools/pre-execute', onPreExecute),
    sessionOff,
  ]

  // A host that accepts the config says nothing about it, so "mounted and watching" and
  // "never reached" were indistinguishable. The launcher's startup exporter is warn-level
  // (dsh-app-boot `boot()` sets `levels: { default: 2 }`), so a host log line would be
  // filtered exactly where an operator looks; the journal is our own channel. Only facts
  // that are safe to publish go in it — no endpoint, path or credential reference.
  journal.emit({
    kind: 'diagnostic', auditId: mintAuditId(), requestId: '', sessionId: '', at: now(),
    reason: `mounted:mode=${config.mode} provider=${config.provider.kind} egress=${config.egress.mode}`,
  })

  function close(): void {
    for (const dispose of disposers) dispose()
    guardOff()
    resultOff()
    void coordinator.close()
  }

  return runtime
}

/**
 * The cordis entry point. Everything it needs that a `cordis.yml` block cannot express is
 * derived from the validated config, so a deployment can never inject a provider the
 * config did not name.
 */
export function apply(ctx: Context, config: unknown): void {
  ctx.effect(() => {
    // Constructing the provider outside the validated config path would let a bad
    // config install and then abstain forever, so any refusal here throws at load.
    const runtime = mountJey(ctx, config, { provider: providerFor(config) })
    return () => runtime.close()
  })
}

/**
 * Resolve a credential *reference*. A bare key never appears in config, and no provider
 * reads an environment variable on its own initiative: `env:NAME` must be written out.
 */
export function resolveCredential(reference: string | undefined): string | undefined {
  if (reference === undefined) return undefined
  const separator = reference.indexOf(':')
  if (separator < 0) return undefined
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
  // `keystore:` and anything else are unwired; returning undefined makes the provider
  // refuse the request instead of sending it unauthenticated.
  return undefined
}

/** Built from the raw config so a rejected config never reaches a provider constructor. */
/**
 * Build the provider the validated config names. Exported for the read-only doctor, which
 * has to probe the same object the plugin would use — a second construction path would be
 * a second place where a config could be interpreted differently.
 */
export function providerFor(raw: unknown): DecisionProvider {
  const config = raw as Partial<JeyConfig>
  const provider = config.provider
  if (provider === undefined || provider.kind === 'unconfigured' || provider.kind === 'mock') return new MockProvider()
  if (provider.kind === 'local') {
    const local = provider.local
    if (local === undefined) throw new Error('jey: provider.kind=local without a local block')
    // External ownership only: Jey never launches, restarts, or downloads anything to
    // satisfy a decision. An unreachable service answers LOCAL_NOT_READY and the policy
    // layer escalates, rather than the plugin quietly failing open. And the checkpoint it
    // names has to be the one the operator pinned, checked before any state is sent.
    return new ExpectedProvider(
      new LocalProvider({ endpoint: local.endpoint, token: () => resolveCredential(local.tokenRef) }),
      local.expectedModel,
    )
  }
  if (provider.kind === 'typesafe') {
    const typesafe = provider.typesafe
    const destinationId = config.egress?.destinations?.find((d: { id: string; endpoint: string }) => d.endpoint === typesafe?.endpointOrigin)?.id ?? 'unaliased'
    return new TypesafeProvider({
      model: typesafe?.model ?? '',
      credential: () => resolveCredential(typesafe?.credentialRef),
      destinationId,
    })
  }
  throw new Error(`jey: no provider implementation for '${provider?.kind}'`)
}

export const name = 'jey'

/** Only `tools` is required; the approval seam is read opportunistically, as the host itself does. */
export const inject = ['tools']

export const jeyPlugin = { name, inject, apply }
