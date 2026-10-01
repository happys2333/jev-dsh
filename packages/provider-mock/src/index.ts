import type {
  DecisionProvider, DecisionRequest, DecisionResponse, ProviderCapabilities, ProviderIdentity,
  ProbabilityMetadata, Question, QuestionOutcome,
} from 'jev-contracts'

/**
 * A synthetic provider, for the engineering gates only.
 *
 * It answers from a fixed table so a test can prove the whole loop — snapshot, request,
 * observation, policy, host mapping, audit — without a model. It is never a substitute for
 * `local-qualified` or `cloud-qualified`: every response reports `kind: 'mock'` and
 * `synthetic: true`, and the config layer refuses `enforce` together with `mock` (spec 6.5),
 * so it cannot quietly become a production decision-maker.
 *
 * Both adapters share this one implementation on purpose. A second mock would be a second
 * place where the rule "a synthetic answer always announces itself" can be broken.
 */
export interface MockProbeOptions {
  /** Identity the mock reports, so an applicability check can be made to match or not. */
  readonly identity?: Partial<ProviderIdentity>
  /**
   * Present when the answers should claim a held-out calibration. Absent means the
   * observation says plainly that it is uncalibrated.
   */
  readonly calibrationId?: string
}

const REPORTED: ProviderIdentity = {
  kind: 'mock',
  providerVersion: '0.0.0',
  requestedModel: 'mock-static',
  resolvedModel: 'mock-static',
  modelRevision: null,
  weightsDigest: null,
  tokenizerRevision: null,
  templateDigest: 'sha256:mock-template',
  quantization: null,
  synthetic: true,
}

type Probability = ProbabilityMetadata

function probability(calibrationId: string | undefined): Probability {
  return calibrationId === undefined
    ? { origin: 'synthetic', calibration: 'uncalibrated', calibrationId: null }
    : { origin: 'native-logits', calibration: 'held-out', calibrationId }
}

/** `answers[q.id]` is a 0..1 score; an unlisted or unusable id sits at an even 0.5. */
function scoreFor(answers: Record<string, number>, question: Question): number {
  const declared = answers[question.id]
  if (typeof declared !== 'number' || !Number.isFinite(declared)) return 0.5
  return Math.min(1, Math.max(0, declared))
}

/** Weights peaked at `target` over `n` slots, normalised to sum 1. */
function peaked(n: number, target: number): number[] {
  const weights = Array.from({ length: n }, (_, i) => 1 / (1 + Math.abs(i - target) * 4))
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map(w => w / total)
}

function indexFor(score: number, slots: number): number {
  return Math.min(slots - 1, Math.max(0, Math.round(score * (slots - 1))))
}

function answerFor(question: Question, score: number, calibrationId: string | undefined) {
  const meta = probability(calibrationId)
  if (question.kind === 'boolean') {
    return {
      kind: 'boolean' as const, pYes: score, probability: meta,
      ...(calibrationId === undefined ? {} : { calibratedPYes: score }),
    }
  }
  if (question.kind === 'choice') {
    const slots = Math.max(1, question.options.length)
    const target = indexFor(score, slots)
    const weights = peaked(slots, target)
    const probabilities = Object.fromEntries(question.options.map((o, i) => [o.id, weights[i] ?? 0]))
    return {
      kind: 'choice' as const,
      selected: question.options[target]?.id ?? '',
      probabilities, probability: meta,
      ...(calibrationId === undefined ? {} : { calibratedProbabilities: probabilities }),
    }
  }
  const weights = peaked(question.levels.length, indexFor(score, question.levels.length))
  const probabilities = Object.fromEntries(weights.map((w, i) => [String(i), w]))
  const expectedIndex = weights.reduce((sum, w, i) => sum + i * w, 0)
  return {
    kind: 'score' as const, expectedIndex, levels: question.levels, probabilities, probability: meta,
    ...(calibrationId === undefined ? {} : { calibratedProbabilities: probabilities }),
  }
}

export class MockProvider implements DecisionProvider {
  readonly seen: DecisionRequest[] = []
  calls = 0

  readonly answers: Record<string, number>
  readonly behaviour: 'answer' | 'fail' | 'abstain'
  readonly probe: MockProbeOptions

  /** How many upcoming `evaluate` calls should block until {@link release}. */
  #held = 0
  #waiters: (() => void)[] = []
  #resolveHolding: () => void = () => {}

  /**
   * Resolves as soon as a held call is actually inside `evaluate`, so a test can perform
   * host state changes *while* a decision is in flight instead of guessing a sleep.
   */
  readonly holding: Promise<void> = new Promise(resolve => { this.#resolveHolding = resolve })

  // Explicit fields, not constructor parameter properties: Node's type stripping rejects those.
  constructor(answers: Record<string, number> = {}, behaviour: 'answer' | 'fail' | 'abstain' = 'answer',
    probe: MockProbeOptions = {}) {
    this.answers = answers
    this.behaviour = behaviour
    this.probe = probe
  }

  /** Block the next `n` evaluations until {@link release} is called. */
  hold(n = 1): void {
    this.#held += n
  }

  release(): void {
    const waiters = this.#waiters
    this.#waiters = []
    for (const wake of waiters) wake()
  }

  async capabilities(): Promise<ProviderCapabilities> {
    return {
      provider: this.identity(),
      questionKinds: ['boolean', 'choice', 'score'],
      maxInputBytes: 32_768,
      maxQuestions: 16,
      cancellation: 'cooperative',
    }
  }

  private identity(): ProviderIdentity {
    // A caller may steer *which model* is reported, to exercise an applicability check, but
    // not which class of answerer it is: `kind` and `synthetic` are asserted last and are
    // never overridable. A mock that could describe itself as a `local` model is the exact
    // disguise spec §3.2 exists to prevent, and `resolvedModel` alone carries the disguise.
    return { ...REPORTED, ...this.probe.identity, kind: 'mock', synthetic: true }
  }

  async evaluate(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<DecisionResponse> {
    this.calls += 1
    this.seen.push(request)
    const started = Date.now()
    if (this.#held > 0) {
      this.#held -= 1
      this.#resolveHolding()
      await new Promise<void>(wake => { this.#waiters.push(wake) })
    }
    const base = {
      schemaVersion: '1' as const,
      requestId: request.requestId,
      snapshot: request.snapshot,
      provider: this.identity(),
      timing: { queueMs: 0, inferenceMs: 0, totalMs: Date.now() - started },
      usage: { inputTokens: null, outputTokens: null, costUsd: null, costBasis: 'unknown' as const },
      egress: { occurred: false, destinationId: null },
    }

    if (context.signal.aborted) {
      return {
        ...base, status: 'failed',
        outcomes: request.questions.map(q => ({ id: q.id, status: 'error' as const, code: 'CANCELLED' as const, retryable: false })),
      }
    }
    if (this.behaviour === 'fail') {
      return {
        ...base, status: 'failed',
        outcomes: request.questions.map(q => ({ id: q.id, status: 'error' as const, code: 'OVERLOADED' as const, retryable: true })),
      }
    }
    const outcomes: QuestionOutcome[] = request.questions.map(q => this.behaviour === 'abstain'
      ? { id: q.id, status: 'abstained' as const, reason: 'unsupported' as const }
      : { id: q.id, status: 'answered' as const, answer: answerFor(q, scoreFor(this.answers, q), this.probe.calibrationId) })
    return { ...base, status: 'ok', outcomes }
  }

  async close(): Promise<void> {}
}
