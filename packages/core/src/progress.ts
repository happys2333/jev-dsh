import type { JsonValue } from 'jey-contracts'
import { digestJson } from './canonical.ts'

/**
 * No-progress detection, spec section 9.
 *
 * Repeating the exact same failing call is a code-level fact, so it is counted here
 * and not handed to a model. Reaching the limit pauses *that path* with a
 * recoverable result — it never bans the agent, and never ends the user's task.
 */

/**
 * What identifies the *path* a call belongs to, and nothing else. A pre-dispatch check
 * (the host's synchronous guard) can only supply this much, so it gets its own type
 * instead of being forced to invent a status or a sequence number to ask one question.
 */
export interface PathIdentity {
  readonly scopeKey: string
  readonly toolName: string
  readonly normalizedArguments: JsonValue
}

export interface CallObservation extends PathIdentity {
  readonly status: 'success' | 'failure'
  /** Only a deterministic, recognisable error contributes to the fingerprint. */
  readonly deterministicError: string | null
  readonly resourceVersions: Readonly<Record<string, string>>
  /**
   * Identity of the model-requested call owning this execution tree. The host resolves
   * it for root and nested calls alike (`ToolExecution.rootCallId`), so a PTC child and
   * its parent share one value — which makes it the right key for *counting one attempt
   * once*, and the wrong key for a pause that has to survive across attempts.
   */
  readonly rootCallId: string | null
  /** Status polling has its own budget and is not "stuck" by repeating. */
  readonly isPoll: boolean
  readonly observationSequence: number
}

export interface ProgressConfig {
  readonly maxIdenticalFailures: number
  readonly pollBudget: number
}

export interface PathState {
  readonly fingerprint: string
  readonly count: number
  readonly polls: number
  readonly paused: boolean
  readonly lastSequence: number
  /**
   * The root call already counted on this path. A parent result and its nested child
   * results carry the same `rootCallId`, so without this the same attempt would count
   * once per dispatch and the limit would fire early.
   */
  readonly lastRootCallId: string | null
}

export type ProgressStore = Readonly<Record<string, PathState>>

export type ProgressOutcome =
  | { readonly kind: 'progress' }
  | { readonly kind: 'repeat-failure'; readonly count: number }
  | { readonly kind: 'path-paused'; readonly count: number }
  | { readonly kind: 'poll-budget-exhausted'; readonly polls: number }
  | { readonly kind: 'ignored-duplicate'; readonly reason: 'already-observed' }

export const EMPTY_PROGRESS: ProgressStore = {}

/** An initial example value, not a universal constant: it belongs to the config. */
export const DEFAULT_PROGRESS_CONFIG: ProgressConfig = { maxIdenticalFailures: 3, pollBudget: 20 }

/**
 * The path a call belongs to: one scope, one tool, one set of arguments. Deliberately
 * not `rootCallId`, which the host mints fresh per model-requested call — a counter
 * keyed by it restarts on every turn and a pause is then unreachable in real use.
 * Including the scope matters the other way: a paused path in one session may not
 * silence an unrelated one that happens to call the same tool the same way.
 */
export function pathKeyOf(id: PathIdentity): string {
  return digestJson([id.scopeKey, id.toolName, id.normalizedArguments])
}

function pathKey(obs: CallObservation): string {
  return pathKeyOf(obs)
}

/**
 * Anything that legitimately differs — different arguments, a different
 * deterministic error, a moved resource version — produces a different fingerprint,
 * which resets the count instead of accumulating it.
 */
export function fingerprintOf(obs: CallObservation): string {
  return digestJson([
    obs.toolName,
    obs.normalizedArguments,
    obs.deterministicError,
    obs.resourceVersions,
  ])
}

export function isPathPaused(store: ProgressStore, id: PathIdentity): boolean {
  return store[pathKeyOf(id)]?.paused === true
}

/** The pause state for a path, when there is one, for a diagnosable reason code. */
export function pausedPath(store: ProgressStore, id: PathIdentity): PathState | undefined {
  const state = store[pathKeyOf(id)]
  return state !== undefined && state.paused ? state : undefined
}

export function observeCall(
  store: ProgressStore,
  obs: CallObservation,
  config: ProgressConfig = DEFAULT_PROGRESS_CONFIG,
): { readonly store: ProgressStore; readonly outcome: ProgressOutcome } {
  const key = pathKey(obs)
  const previous = store[key]

  // The same attempt delivered twice — an outer call plus its nested child results, or a
  // replayed notification — must not read as two failures. `rootCallId` is shared by a
  // parent and everything under it, so it is what identifies one attempt.
  const sameAttempt = previous !== undefined && obs.rootCallId !== null && previous.lastRootCallId === obs.rootCallId
  if (previous !== undefined && (sameAttempt || obs.observationSequence <= previous.lastSequence)) {
    return { store, outcome: { kind: 'ignored-duplicate', reason: 'already-observed' } }
  }

  if (obs.status === 'success') {
    const next = { ...store }
    delete next[key]
    return { store: next, outcome: { kind: 'progress' } }
  }

  if (obs.isPoll) {
    const polls = (previous?.polls ?? 0) + 1
    const state: PathState = {
      fingerprint: fingerprintOf(obs),
      count: previous?.count ?? 0,
      polls,
      paused: previous?.paused ?? false,
      lastSequence: obs.observationSequence,
      lastRootCallId: obs.rootCallId,
    }
    if (polls > config.pollBudget) {
      return { store: { ...store, [key]: { ...state, paused: true } }, outcome: { kind: 'poll-budget-exhausted', polls } }
    }
    return { store: { ...store, [key]: state }, outcome: { kind: 'progress' } }
  }

  const fingerprint = fingerprintOf(obs)

  // A paused path stays paused on the same fingerprint. Resetting the count here
  // would hand back a fresh failure budget every round and let the agent loop
  // `maxIdenticalFailures` calls at a time indefinitely.
  if (previous !== undefined && previous.paused && previous.fingerprint === fingerprint) {
    const state: PathState = { ...previous, lastSequence: obs.observationSequence, lastRootCallId: obs.rootCallId }
    return { store: { ...store, [key]: state }, outcome: { kind: 'path-paused', count: previous.count } }
  }

  const sameAsBefore = previous !== undefined && previous.fingerprint === fingerprint
  const count = sameAsBefore ? previous.count + 1 : 1

  if (count >= config.maxIdenticalFailures) {
    const state: PathState = {
      fingerprint, count, polls: previous?.polls ?? 0, paused: true,
      lastSequence: obs.observationSequence, lastRootCallId: obs.rootCallId,
    }
    return { store: { ...store, [key]: state }, outcome: { kind: 'path-paused', count } }
  }
  const state: PathState = {
    fingerprint, count, polls: previous?.polls ?? 0, paused: false,
    lastSequence: obs.observationSequence, lastRootCallId: obs.rootCallId,
  }
  return { store: { ...store, [key]: state }, outcome: { kind: 'repeat-failure', count } }
}
