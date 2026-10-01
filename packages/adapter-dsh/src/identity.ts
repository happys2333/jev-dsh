import type {
  DecisionProvider, DecisionRequest, DecisionResponse, ProviderCapabilities, ProviderIdentity,
} from 'jev-contracts'
import type { ModelIdentity } from 'jev-core'
import { identityMismatches } from 'jev-core'

export { identityMismatches } from 'jev-core'

/**
 * The config schema requires `provider.local.expectedModel`, and the service reports
 * which weights it actually opened. Nothing connected the two, so a loopback service
 * running a different checkpoint than the operator pinned would have been accepted.
 *
 * This wrapper is that connection, and it runs *before* the first request: the
 * identity probe carries no task state, so a mismatch costs a token check and never
 * leaks a goal, a constraint, or a tool argument to the wrong model.
 */

export class IdentityMismatch extends Error {
  readonly code = 'UNSUPPORTED_CAPABILITY' as const
  readonly retryable = false
  readonly fields: readonly string[]

  constructor(fields: readonly string[], reported: ProviderIdentity) {
    super(`jey: the local service reports ${JSON.stringify(reported.requestedModel)} `
      + `${JSON.stringify(reported.modelRevision)}, which does not match provider.local.expectedModel `
      + `on ${fields.join(', ')}`)
    this.name = 'IdentityMismatch'
    this.fields = fields
  }
}

export class ExpectedProvider implements DecisionProvider {
  #inner: DecisionProvider
  #expected: ModelIdentity
  #gate: Promise<ProviderCapabilities> | null = null

  constructor(inner: DecisionProvider, expected: ModelIdentity) {
    this.#inner = inner
    this.#expected = expected
  }

  /** One probe, cached, and re-thrown identically: a refused identity stays refused. */
  #checked(): Promise<ProviderCapabilities> {
    this.#gate ??= this.#inner.capabilities().then(capabilities => {
      const fields = identityMismatches(this.#expected, capabilities.provider)
      if (fields.length > 0) throw new IdentityMismatch(fields, capabilities.provider)
      return capabilities
    }, error => {
      // A service that cannot name itself is not a service we will send state to.
      this.#gate = null
      throw error
    })
    return this.#gate
  }

  async capabilities(): Promise<ProviderCapabilities> { return this.#checked() }

  async evaluate(request: DecisionRequest, context: { readonly signal: AbortSignal }): Promise<DecisionResponse> {
    await this.#checked()
    return this.#inner.evaluate(request, context)
  }

  async close(): Promise<void> {
    this.#gate = null
    await this.#inner.close()
  }
}
