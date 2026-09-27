import test from 'node:test'
import assert from 'node:assert/strict'
import { fitToBudget, type StateSection } from '../../src/index.ts'

const CJK = '不要在生产环境执行任何写操作，先看配置再动手'

function sections(overrides: Partial<Record<StateSection['id'], StateSection>> = {}): StateSection[] {
  const base: StateSection[] = [
    { id: 'policy', kind: 'policy', value: { constraints: [CJK] } },
    { id: 'call', kind: 'current-call', value: { tool: 'write_file', args: { path: 'a.txt' } } },
    { id: 'results', kind: 'recent-result', value: [{ tool: 'read_file', status: 'ok' }] },
    { id: 'chat', kind: 'conversation', value: [{ role: 'old' }, { role: 'mid' }, { role: 'new' }] },
  ]
  const merged = new Map(base.map(s => [s.id, s]))
  for (const [id, s] of Object.entries(overrides)) merged.set(id, s as StateSection)
  return [...merged.values()]
}

test('a payload that already fits comes back untouched', () => {
  const r = fitToBudget(sections(), 100_000)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.deepEqual(r.omissions, [])
    assert.deepEqual(Object.keys(r.state).sort(), ['call', 'chat', 'policy', 'results'])
  }
})

test('conversation is dropped oldest-first, then the whole section', () => {
  const r = fitToBudget(sections(), 190)
  assert.equal(r.ok, true)
  if (r.ok) {
    const dropped = r.omissions.map(o => o.path)
    assert.ok(dropped.includes('chat[0]'), `expected chat[0] in ${dropped.join(',')}`)
    assert.deepEqual((r.state.chat as unknown[]).at(-1), { role: 'new' })
  }
})

test('dropping the whole section is recorded with how much it saved', () => {
  const r = fitToBudget(sections(), 150)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal('chat' in r.state, false)
    const whole = r.omissions.find(o => o.path === 'chat')
    assert.ok(whole !== undefined && whole.originalBytes > 0 && whole.keptBytes === 0)
  }
})

test('a truncated payload is always still parseable JSON', () => {
  for (let budget = 40; budget < 400; budget += 7) {
    const r = fitToBudget(sections(), budget)
    if (r.ok) assert.doesNotThrow(() => JSON.parse(JSON.stringify(r.state)), `budget ${budget}`)
  }
})

test('protected content is never shortened; the fit fails instead', () => {
  const r = fitToBudget([{ id: 'policy', kind: 'policy', value: { constraints: [CJK.repeat(6)] } }], 120)
  assert.equal(r.ok, false, 'a policy statement trimmed to fit is not a policy statement')
  if (!r.ok) {
    assert.equal(r.code, 'INSUFFICIENT_CONTEXT')
    assert.ok(r.neededBytes > 120, 'the caller has to be told how much was actually needed')
  }
})

test('a multi-byte payload that cannot fit is not mangled into valid-looking text', () => {
  const r = fitToBudget([{ id: 'policy', kind: 'policy', value: { note: '🥲'.repeat(40) } }], 60)
  assert.equal(r.ok, false)
})

test('R09: a long shell command keeps its trailing operation or the request is not made', () => {
  // The regression this whole change is about: the dangerous tail used to be the part
  // that got cut, while the payload still reported success.
  const dangerous = '; rm -rf /var/lib/postgresql'
  const command = `backup --db orders `.repeat(300) + dangerous
  const sections: StateSection[] = [
    { id: 'policy', kind: 'policy', value: { constraints: ['read-only inspection'] } },
    { id: 'call', kind: 'current-call', value: { tool: 'shell', arguments: { command } } },
    { id: 'chat', kind: 'conversation', value: [{ role: 'user', text: 'older context' }] },
  ]
  const r = fitToBudget(sections, 256)
  assert.equal(r.ok, false, 'dropping the conversation is not enough here, so nothing may be sent')
  if (!r.ok) assert.match(r.reason, /policy and current call/)

  // With room for the call, history goes first and the command survives intact.
  const fits = fitToBudget(sections, 6000)
  assert.equal(fits.ok, true)
  if (fits.ok) {
    const call = fits.state.call as { arguments: { command: string } }
    assert.equal(call.arguments.command, command, 'the judged arguments must be the real ones')
    assert.ok(call.arguments.command.endsWith(dangerous))
  }
})

test('policy plus current call that cannot fit reports INSUFFICIENT_CONTEXT', () => {
  const r = fitToBudget(sections(), 30)
  assert.equal(r.ok, false)
  if (!r.ok) {
    assert.equal(r.code, 'INSUFFICIENT_CONTEXT')
    assert.ok(r.neededBytes > 30)
  }
})

test('never returns a payload larger than the budget', () => {
  for (let budget = 60; budget < 500; budget += 11) {
    const r = fitToBudget(sections(), budget)
    if (r.ok) assert.ok(r.bytes <= budget, `budget ${budget} produced ${r.bytes}`)
  }
})
