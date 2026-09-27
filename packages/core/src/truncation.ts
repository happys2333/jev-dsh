import type { JsonValue } from 'jey-contracts'
import { utf8Bytes } from './canonical.ts'

/**
 * Context assembly under a byte budget, spec section 5.2.
 *
 * Only history-like sections may be sacrificed, and only whole entries at a time, oldest
 * first. A policy statement and the frozen arguments of the call being judged are never
 * rewritten: shortening them used to be the last resort here, which let a 6 KB shell
 * command arrive as 117 bytes with its trailing operation gone while the request still
 * reported success. If what must stay cannot fit, that is reported as
 * `INSUFFICIENT_CONTEXT` and no semantic request is made.
 */

export type SectionKind = 'policy' | 'current-call' | 'recent-result' | 'conversation'

export interface StateSection {
  readonly id: string
  readonly kind: SectionKind
  readonly value: JsonValue
}

export interface Omission {
  readonly path: string
  readonly originalBytes: number
  readonly keptBytes: number
  readonly droppedItems: number
}

export type Fit =
  | { readonly ok: true; readonly state: Record<string, JsonValue>; readonly bytes: number; readonly omissions: readonly Omission[] }
  | { readonly ok: false; readonly code: 'INSUFFICIENT_CONTEXT'; readonly reason: string; readonly neededBytes: number }

const DROPPABLE: readonly SectionKind[] = ['conversation', 'recent-result']

function bytesOf(state: Record<string, JsonValue>): number {
  return utf8Bytes(JSON.stringify(state))
}

export function fitToBudget(sections: readonly StateSection[], maxBytes: number): Fit {
  const state: Record<string, JsonValue> = {}
  for (const s of sections) state[s.id] = s.value
  const omissions: Omission[] = []

  for (let guard = 0; bytesOf(state) > maxBytes; guard++) {
    if (guard > 500) return { ok: false, code: 'INSUFFICIENT_CONTEXT', reason: 'did not converge', neededBytes: bytesOf(state) }

    const target = sections.find(s => DROPPABLE.includes(s.kind) && s.id in state)
    if (target === undefined) {
      // Nothing sacrificial is left. Whatever remains is policy and this call, and those
      // are exactly the parts a verdict may not be made about in shortened form.
      return {
        ok: false,
        code: 'INSUFFICIENT_CONTEXT',
        reason: 'policy and current call do not fit the budget',
        neededBytes: bytesOf(state),
      }
    }

    const value = state[target.id] as JsonValue
    if (Array.isArray(value) && value.length > 1) {
      const [oldest, ...rest] = value as JsonValue[]
      state[target.id] = rest
      omissions.push({
        path: `${target.id}[0]`,
        originalBytes: utf8Bytes(JSON.stringify(oldest)),
        keptBytes: 0,
        droppedItems: 1,
      })
      continue
    }
    delete state[target.id]
    omissions.push({
      path: target.id,
      originalBytes: utf8Bytes(JSON.stringify(value)),
      keptBytes: 0,
      droppedItems: Array.isArray(value) ? value.length : 1,
    })
  }

  return { ok: true, state, bytes: bytesOf(state), omissions }
}
