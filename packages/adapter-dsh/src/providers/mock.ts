import type {
  DecisionProvider, DecisionRequest, DecisionResponse, ProviderCapabilities, ProviderIdentity, QuestionOutcome,
} from 'jey-contracts'

/**
 * A synthetic provider, for the engineering gates only.
 *
 * It answers from a fixed table so a host test can prove the whole loop — snapshot,
 * request, observation, policy, host mapping, audit — without a model. It is never a
 * substitute for `local-qualified` or `cloud-qualified`: every response carries
 * `synthetic: true`, and the config layer refuses `enforce` together with `mock`
 * (spec 6.5), so it cannot quietly become a production decision-maker.
 */
export interface MockProbeOptions {
  /** Identity the mock reports, so an applicability check can be made to match or not. */
  readonly identity?: Partial<ProviderIdentity>
  /**
   * Present when the answers should claim a held-out calibration, with a value for
   * `calibratedPYes`. Absent means the observation says plainly that it is uncalibrated.
   */
  readonly calibrationId?: string
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
    const reported: ProviderIdentity = {
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
    // A caller may steer which identity is reported, to exercise an applicability check,
    // but `synthetic` is asserted last and never overridable: a synthetic answer must
    // always announce itself as one.
    return { ...reported, ...this.probe.identity, synthetic: true }
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
    const outcomes: QuestionOutcome[] = request.questions.map(q => {
      if (this.behaviour === 'abstain') return { id: q.id, status: 'abstained' as const, reason: 'unsupported' as const }
      const pYes = this.answers[q.id] ?? 0.5
      if (this.probe.calibrationId !== undefined) {
        // Claims a held-out calibration, so an applicability check has something to match.
        // It is still `synthetic: true` on the provider identity above.
        return {
          id: q.id, status: 'answered' as const,
          answer: {
            kind: 'boolean' as const, pYes, calibratedPYes: pYes,
            probability: {
              origin: 'native-logits' as const, calibration: 'held-out' as const,
              calibrationId: this.probe.calibrationId,
            },
          },
        }
      }
      return {
        id: q.id, status: 'answered' as const,
        answer: {
          kind: 'boolean' as const, pYes,
          probability: { origin: 'synthetic' as const, calibration: 'uncalibrated' as const, calibrationId: null },
        },
      }
    })
    return { ...base, status: 'ok', outcomes }
  }

  async close(): Promise<void> {}
}
