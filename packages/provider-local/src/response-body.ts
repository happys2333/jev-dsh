/** Bounded JSON transport: deadline/cancellation includes headers AND body. */
export const MAX_RESPONSE_BYTES = 1_048_576

export async function readBoundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('empty response body')
  let completed = false
  let abort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('response body aborted'))
  })
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) throw new Error('response body aborted')
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error('response body exceeds byte bound')
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const item = await Promise.race([reader.read(), aborted])
      if (item.done) break
      total += item.value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw new Error('response body exceeds byte bound')
      chunks.push(item.value)
    }
    const data = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data))
    completed = true
    return parsed
  } finally {
    signal.removeEventListener('abort', abort)
    if (!completed) void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
