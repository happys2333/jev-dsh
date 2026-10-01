import type { ProviderIdentity } from 'jev-contracts'
import type { ModelIdentity } from './config.ts'
import { sameDigest } from './policy.ts'

/** Compare an operator's model pin with the provider identity before sending state. */
export function identityMismatches(expected: ModelIdentity, reported: ProviderIdentity): string[] {
  const out: string[] = []
  if (reported.synthetic) out.push('synthetic')
  if (expected.requested !== reported.requestedModel) out.push('requested')
  if (expected.revision !== reported.modelRevision) out.push('revision')
  for (const field of ['weightsDigest', 'tokenizerRevision', 'quantization'] as const) {
    const wanted = expected[field]
    if (wanted === undefined) continue
    const actual = reported[field]
    if (typeof actual !== 'string') {
      out.push(field)
      continue
    }
    if (field === 'weightsDigest' ? !sameDigest(wanted, actual) : wanted !== actual) out.push(field)
  }
  return out
}
