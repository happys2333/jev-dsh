/**
 * The MCP tools' behaviour: validate against the published schema, build the same snapshot
 * and budget the DSH adapter builds, respect the same egress policy, and hand the request to
 * the same coordinator. Nothing here is a second, softer copy of those rules — that is the
 * reason the tools sit next to `jev-core` instead of in front of their own transport.
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { Ajv2020 } from 'ajv/dist/2020.js'
import type { ValidateFunction } from 'ajv'
import type {
  Answer, DecisionProvider, DecisionRequest, DecisionResponse, JsonValue, Purpose, Question,
  QuestionOutcome,
} from 'jev-contracts'
import {
  DecisionCoordinator, assertSupported, buildSnapshot, checkEgress, fitToBudget, identityMismatches, utf8Bytes,
  type CoordinatorOutcome, type JeyConfig, type SnapshotFacts, type StateSection,
} from 'jev-core'
import { LocalError } from 'jev-provider-local'
import { DEFAULT_RANK_LEVELS, TOOL_INPUT_SCHEMAS, type McpToolName } from './schema.ts'

/** Each tool has one fixed purpose; a caller cannot choose one to dodge a per-purpose rule. */
const PURPOSE: Readonly<Record<McpToolName, Purpose>> = {
  jev_check: 'evidence-check',
  jev_choose: 'explicit-query',
  jev_rank: 'tool-relevance',
}

const CHECK_QUESTION_ID = 'claim-holds'
const CHOICE_QUESTION_ID = 'choose-one'
const NONE_OPTION_ID = 'none-applicable'
const rankId = (candidateId: string): string => `rank:${candidateId}`

export interface McpRuntime {
  readonly config: JeyConfig
  readonly coordinator: DecisionCoordinator
  readonly provider: DecisionProvider
  readonly now: () => number
}

/**
 * `protocol` is a malformed request and must come back as a JSON-RPC error; `tool` is a
 * well-formed request whose judgement could not be made and must come back as `isError`.
 * Conflating them is what makes a client retry a bad argument forever.
 */
export type ToolOutcome =
  | { readonly kind: 'ok', readonly structured: Record<string, JsonValue>, readonly text: string }
  | { readonly kind: 'protocol', readonly code: 'INVALID_PARAMS', readonly message: string }
  | { readonly kind: 'tool', readonly code: string, readonly message: string, readonly retryable: boolean }

const validators = new Map<McpToolName, ValidateFunction>()

/**
 * Validate with the very schema `tools/list` publishes. Two descriptions of one input are
 * free to disagree, and the disagreement would look like a working tool.
 */
export function inputErrors(name: McpToolName, args: unknown): readonly string[] {
  let validate = validators.get(name)
  if (validate === undefined) {
    const ajv = new Ajv2020({ allErrors: true, strict: true, useDefaults: true })
    validate = ajv.compile(TOOL_INPUT_SCHEMAS[name])
    validators.set(name, validate)
  }
  if (validate(args) === true) return []
  return (validate.errors ?? []).map(e => `${e.instancePath === '' ? '/' : e.instancePath} ${e.message ?? 'invalid'}`)
}

type Fields = Readonly<Record<string, JsonValue>>

function fields(value: unknown): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Fields : {}
}

function string(value: JsonValue | undefined, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function listOf(value: JsonValue | undefined): readonly JsonValue[] {
  return Array.isArray(value) ? value : []
}

function buildQuestions(name: McpToolName, input: Fields): {
  readonly questions: readonly Question[]
  readonly sections: readonly StateSection[]
  readonly levels: readonly string[]
} {
  if (name === 'jev_check') {
    const claim = string(input.claim)
    const evidence = string(input.evidence)
    return {
      questions: [{
        kind: 'boolean',
        id: CHECK_QUESTION_ID,
        instructions: 'Does the evidence support the claim? Answer yes only when it does.\n'
          + `Claim: ${claim}\nEvidence: ${evidence}`,
      }],
      sections: [
        { id: 'claim', kind: 'policy', value: claim },
        { id: 'evidence', kind: 'current-call', value: evidence },
      ],
      levels: [],
    }
  }

  if (name === 'jev_choose') {
    const instruction = string(input.instruction)
    const options = listOf(input.options).map(o => fields(o))
    return {
      questions: [{
        kind: 'choice',
        id: CHOICE_QUESTION_ID,
        instructions: 'Choose exactly one option id for this decision, or the option meaning that none '
          + `of them fits.\nDecision: ${instruction}\n`
          + `Options:\n${options.map(o => `- ${string(o.id)}: ${string(o.description)}`).join('\n')}`,
        options: [
          ...options.map(o => ({ id: string(o.id), description: string(o.description) })),
          { id: NONE_OPTION_ID, description: 'None of the listed options is appropriate.' },
        ],
      }],
      sections: [
        { id: 'instruction', kind: 'policy', value: instruction },
        { id: 'context', kind: 'recent-result', value: input.context ?? null },
        { id: 'options', kind: 'current-call', value: [...options] },
      ],
      levels: [],
    }
  }

  const instruction = string(input.instruction)
  const candidates = listOf(input.candidates).map(c => fields(c))
  const given = listOf(input.levels).map(l => string(l)).filter(l => l !== '')
  const levels = given.length > 0 ? given : [...DEFAULT_RANK_LEVELS]
  return {
    questions: candidates.map(c => ({
      kind: 'score' as const,
      id: rankId(string(c.id)),
      instructions: 'Score this candidate against the instruction on its own, independently of the '
        + `others. Levels, worst first: ${levels.join(' | ')}\nInstruction: ${instruction}\nCandidate: ${string(c.text)}`,
      levels,
    })),
    sections: [
      { id: 'instruction', kind: 'policy', value: instruction },
      ...candidates.map((c, i) => ({ id: `candidate:${i}`, kind: 'current-call' as const, value: { ...c } })),
    ],
    levels,
  }
}

/** Monotonic per process, so two calls in the same second still get distinct snapshot refs. */
let sequence = 0

/**
 * The snapshot this process builds for its own call. `sessionId` is never caller-supplied:
 * a client that could name its own session could borrow another session's budget, or present
 * a bare question as a host-attested tool call and have it treated as one.
 */
function factsFor(goal: string, truncated: readonly string[]): SnapshotFacts {
  return {
    sessionId: 'mcp', agentId: 'mcp', turn: 1, step: ++sequence, generation: 1,
    policyVersion: 'mcp-v1', taskVersion: 1,
    task: {
      initialGoal: goal, currentSubgoal: goal, constraints: [], latestRevisionEvent: null,
      requirementsUnavailable: true,
    },
    catalog: [], call: null, recentResults: [], observationSequence: sequence, truncated,
  }
}

export async function runTool(
  runtime: McpRuntime,
  name: McpToolName,
  args: unknown,
  signal: AbortSignal,
): Promise<ToolOutcome> {
  const problems = inputErrors(name, args)
  if (problems.length > 0) return { kind: 'protocol', code: 'INVALID_PARAMS', message: problems.join('; ') }

  const input = fields(args)
  const { questions, sections, levels } = buildQuestions(name, input)
  if (questions.length > runtime.config.limits.maxQuestions) {
    return {
      kind: 'tool', code: 'INVALID_INPUT', retryable: false,
      message: `${questions.length} questions exceed limits.maxQuestions (${runtime.config.limits.maxQuestions})`,
    }
  }

  const fit = fitToBudget(sections, runtime.config.limits.maxStateBytes)
  if (!fit.ok) {
    return {
      kind: 'tool', code: fit.code, retryable: false,
      message: `the request does not fit the state budget: ${fit.reason} (needs ${fit.neededBytes} bytes)`,
    }
  }

  const goal = string(input.instruction) || string(input.claim) || 'mcp judgement'
  const request: DecisionRequest = {
    schemaVersion: '1',
    requestId: `req_${randomUUID()}`,
    purpose: PURPOSE[name],
    snapshot: buildSnapshot(factsFor(goal, fit.omissions.map(o => o.path))).ref,
    state: fit.state,
    questions,
    budget: { maxElapsedMs: runtime.config.limits.deadlineMs, maxInputBytes: runtime.config.limits.maxStateBytes },
  }

  // Nothing to ask is an answer, not a failure: an empty candidate list is a legitimate rank
  // request. It is not sent anywhere, and it is not reported as an unsupported capability.
  // `synthetic: true` holds here in the literal sense — no model answered this.
  if (questions.length === 0) {
    const empty = {
      requestId: request.requestId,
      provider: { kind: runtime.config.provider.kind, resolvedModel: 'not-called', synthetic: true },
      kind: 'score', instruction: string(input.instruction), levels: [...levels],
      scores: [], ordering: [], noneApplicable: true, abstained: false,
    } satisfies Record<string, JsonValue>
    return { kind: 'ok', structured: empty, text: JSON.stringify(empty) }
  }

  const egressFailure = egressCheck(runtime, request)
  if (egressFailure !== null) return egressFailure

  let capabilities
  try {
    capabilities = await runtime.provider.capabilities()
  } catch (error) {
    // Two different failures wear different faces here: the service being unreachable is
    // not the service declining to answer these questions, and reporting one as the other
    // would tell an operator to fix the wrong thing.
    const code = error instanceof LocalError ? error.code : 'INVALID_RESPONSE'
    return {
      kind: 'tool', code, retryable: error instanceof LocalError ? error.retryable : false,
      message: `the provider could not be asked what it supports (${error instanceof Error ? error.message : 'unknown error'})`,
    }
  }
  if (runtime.config.provider.kind === 'local' && runtime.config.provider.local !== undefined) {
    const mismatches = identityMismatches(runtime.config.provider.local.expectedModel, capabilities.provider)
    if (mismatches.length > 0) {
      return {
        kind: 'tool', code: 'UNSUPPORTED_CAPABILITY', retryable: false,
        message: `the local provider does not match expectedModel on ${mismatches.join(', ')}`,
      }
    }
  }
  try {
    assertSupported(request.questions, capabilities, utf8Bytes(JSON.stringify(request.state)))
  } catch (error) {
    return {
      kind: 'tool', code: 'UNSUPPORTED_CAPABILITY', retryable: false,
      message: error instanceof Error ? error.message : 'the provider refused this question set',
    }
  }

  const outcome = await runtime.coordinator.submit(request, { signal })
  if (outcome.kind !== 'response') return failedJudgement(outcome)

  const structured = shapeResult(name, request, outcome.response, input, levels)
  // The compatible text is the same bytes rather than a prose paraphrase, so a client that
  // cannot read structuredContent still reads the identical answer.
  return { kind: 'ok', structured, text: JSON.stringify(structured) }
}

/** Network egress is governed by the same policy as the DSH adapter, before any byte goes. */
function egressCheck(runtime: McpRuntime, request: DecisionRequest): ToolOutcome | null {
  const provider = runtime.config.provider
  if (provider.kind === 'mock' || provider.kind === 'unconfigured') return null
  const egress = runtime.config.egress
  const state = request.state
  const verdict = checkEgress(
    {
      mode: egress.mode,
      localOrigins: egress.allowedOrigins ?? [],
      allowedPurposes: egress.allowedPurposes ?? [],
      destinations: egress.destinations ?? [],
    },
    {
      providerKind: provider.kind,
      destinationId: egress.destinations?.find(d => d.endpoint === provider.typesafe?.endpointOrigin)?.id ?? null,
      endpoint: provider.local?.endpoint ?? provider.typesafe?.endpointOrigin ?? null,
      purpose: request.purpose,
      fields: typeof state === 'object' && state !== null && !Array.isArray(state) ? Object.keys(state) : [],
      credentialConfigured: provider.typesafe?.credentialRef !== undefined || provider.local?.tokenRef !== undefined,
      providerExplicitlySelected: true,
    },
  )
  if (verdict.allowed) return null
  return { kind: 'tool', code: verdict.code, retryable: false, message: verdict.reasons.join('; ') }
}

/**
 * A judgement that could not be made. The code is kept as specific as the answering side
 * made it, and so is `retryable`: when the coordinator's own limits are the reason this
 * file decides that, but when a provider failed the provider already said whether trying
 * again is a different request. Re-deriving it from the code here would overwrite that with
 * a guess — a service distinguishes "busy, ask again" from "I gave up on this one".
 */
function failedJudgement(outcome: Exclude<CoordinatorOutcome, { readonly kind: 'response' }>): ToolOutcome {
  const code = outcome.kind === 'failed'
    ? (outcome.code === 'PROVIDER_ERROR' ? 'INVALID_RESPONSE' : outcome.code)
    : outcome.kind === 'timed-out' ? 'TIMEOUT'
      : outcome.kind === 'cancelled' || outcome.kind === 'closed' ? 'CANCELLED'
        : outcome.kind === 'queue-full' ? 'QUEUE_FULL'
          : outcome.kind === 'budget-exceeded' ? 'BUDGET_EXCEEDED'
            : 'INVALID_INPUT'
  const retryable = outcome.kind === 'failed' ? outcome.retryable
    : outcome.kind === 'timed-out' || outcome.kind === 'queue-full'
  const reason = outcome.kind === 'failed' ? `the provider answered ${code}` : `the request was ${outcome.kind}`
  return {
    kind: 'tool', code, retryable,
    message: `the judgement could not be completed (${reason})`,
  }
}

function answered<T extends Answer['kind']>(outcomes: readonly QuestionOutcome[], id: string, kind: T):
  Extract<Answer, { kind: T }> | null {
  const found = outcomes.find(o => o.id === id)
  if (found?.status !== 'answered' || found.answer.kind !== kind) return null
  return found.answer as Extract<Answer, { kind: T }>
}

/**
 * Everything below copies into fresh literals. The contracts use `Readonly<…>` and
 * interfaces, which JSON's own type will not accept, and re-listing the fields is cheaper
 * and clearer than a cast that would also hide a real mismatch.
 */
function providerHeader(response: DecisionResponse): Record<string, JsonValue> {
  return {
    kind: response.provider.kind,
    resolvedModel: response.provider.resolvedModel,
    synthetic: response.provider.synthetic,
  }
}

const UNCALIBRATED: Record<string, JsonValue> = { origin: 'synthetic', calibration: 'uncalibrated', calibrationId: null }

function metadata(meta: { origin: string, calibration: string, calibrationId: string | null }): Record<string, JsonValue> {
  return { origin: meta.origin, calibration: meta.calibration, calibrationId: meta.calibrationId }
}

function distributionOf(source: Readonly<Record<string, number>> | undefined): Record<string, number> {
  return { ...(source ?? {}) }
}

function shapeResult(
  name: McpToolName,
  request: DecisionRequest,
  response: DecisionResponse,
  input: Fields,
  levels: readonly string[],
): Record<string, JsonValue> {
  const header = { requestId: request.requestId, provider: providerHeader(response) }
  if (name === 'jev_check') {
    const answer = answered(response.outcomes, CHECK_QUESTION_ID, 'boolean')
    return {
      ...header, kind: 'boolean', claim: string(input.claim),
      pYes: answer?.pYes ?? 0,
      ...(answer?.calibratedPYes === undefined ? {} : { calibratedPYes: answer.calibratedPYes }),
      probability: answer === null ? UNCALIBRATED : metadata(answer.probability),
      // An abstention stays an abstention: it is never rewritten into a score of zero,
      // which would read to a client as "the evidence says no".
      abstained: answer === null,
    }
  }
  if (name === 'jev_choose') {
    const answer = answered(response.outcomes, CHOICE_QUESTION_ID, 'choice')
    return {
      ...header, kind: 'choice', instruction: string(input.instruction),
      selected: answer?.selected ?? NONE_OPTION_ID,
      probabilities: distributionOf(answer?.probabilities),
      ...(answer?.calibratedProbabilities === undefined
        ? {} : { calibratedProbabilities: distributionOf(answer.calibratedProbabilities) }),
      probability: answer === null ? UNCALIBRATED : metadata(answer.probability),
      abstained: answer === null,
    }
  }
  const candidates = listOf(input.candidates).map(c => string(fields(c).id))
  const scored = candidates.map(id => {
    const answer = answered(response.outcomes, rankId(id), 'score')
    return {
      id,
      expectedIndex: answer?.expectedIndex ?? null,
      probabilities: distributionOf(answer?.probabilities),
    }
  })
  const ranked = scored.filter(s => typeof s.expectedIndex === 'number')
  return {
    ...header, kind: 'score', instruction: string(input.instruction), levels: [...levels],
    scores: scored,
    ordering: ranked.slice().sort((a, b) => (b.expectedIndex ?? 0) - (a.expectedIndex ?? 0)).map(s => s.id),
    // Nothing to rank, or everything on the bottom rung: both mean "none of these applies",
    // and neither is answered by inventing a winner.
    noneApplicable: ranked.length === 0 || ranked.every(s => (s.expectedIndex ?? 0) < 1),
    abstained: ranked.length === 0,
  }
}
