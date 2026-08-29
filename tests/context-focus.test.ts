import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  CONTEXT_FOCUS_KEEP_DEFAULT,
  CONTEXT_FOCUS_KEEP_MAX,
  CONTEXT_FOCUS_TTL_DEFAULT,
  CONTEXT_FOCUS_TTL_MAX,
  isFocusProtected,
  runContextFocusTool,
  getFocusState,
  clearFocusState,
  tickFocusState,
  shouldForcePointerize,
} from '../src/context-focus.ts'

function fakeAgent(): Agent {
  // WeakMap only needs an object identity; no harness methods are touched.
  return {} as Agent
}

test('set default focus (no args) uses defaults', () => {
  const agent = fakeAgent()
  const out = runContextFocusTool(agent, {})
  assert.ok(out.startsWith('ok: context_focus active keep_inline_turns=12 ttl_turns=8'))
  const state = getFocusState(agent)
  assert.equal(state?.keepInlineTurns, CONTEXT_FOCUS_KEEP_DEFAULT)
  assert.equal(state?.remainingTurns, CONTEXT_FOCUS_TTL_DEFAULT)
  assert.equal(state?.tools, undefined)
})

test('clamps keep and ttl to bounds', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { keep_inline_turns: 999, ttl_turns: 999 })
  let state = getFocusState(agent)
  assert.equal(state?.keepInlineTurns, CONTEXT_FOCUS_KEEP_MAX)
  assert.equal(state?.remainingTurns, CONTEXT_FOCUS_TTL_MAX)

  runContextFocusTool(agent, { keep_inline_turns: -5, ttl_turns: 0 })
  state = getFocusState(agent)
  assert.equal(state?.keepInlineTurns, 0)
  assert.equal(state?.remainingTurns, 1)
})

test('invalid numbers return error and do not change state', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { keep_inline_turns: 5, ttl_turns: 5 })
  const before = getFocusState(agent)
  const out = runContextFocusTool(agent, { keep_inline_turns: 'abc' })
  assert.ok(out.startsWith('error: keep_inline_turns'))
  assert.deepEqual(getFocusState(agent), before)
})

test('tools whitelist is trimmed and deduped; empty becomes undefined', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { tools: [' read_file ', '', 'grep_search'] })
  assert.deepEqual(getFocusState(agent)?.tools, ['read_file', 'grep_search'])
  runContextFocusTool(agent, { tools: [' ', ''] })
  assert.equal(getFocusState(agent)?.tools, undefined)
})

test('clear cancels active focus', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { keep_inline_turns: 6 })
  assert.ok(getFocusState(agent))
  const out = runContextFocusTool(agent, { clear: true })
  assert.ok(out.startsWith('ok: context_focus cleared'))
  assert.equal(getFocusState(agent), undefined)
})

test('isFocusProtected: no state → false', () => {
  assert.equal(isFocusProtected('read_file', undefined), false)
})

test('isFocusProtected: matching tool protected, non-matching not', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { tools: ['read_file'], ttl_turns: 5 })
  const state = getFocusState(agent)
  assert.equal(isFocusProtected('read_file', state), true)
  assert.equal(isFocusProtected('grep_search', state), false)
})

test('isFocusProtected: empty whitelist protects all tools', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { ttl_turns: 3 })
  const state = getFocusState(agent)
  assert.equal(isFocusProtected('bash', state), true)
  assert.equal(isFocusProtected('read_file', state), true)
})

test('tickFocusState decrements and expires at zero', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { ttl_turns: 2 })
  assert.equal(tickFocusState(agent), false)
  assert.equal(getFocusState(agent)?.remainingTurns, 1)
  assert.equal(tickFocusState(agent), true) // expired
  assert.equal(getFocusState(agent), undefined)
})

test('isFocusProtected false after expiry', () => {
  const agent = fakeAgent()
  runContextFocusTool(agent, { ttl_turns: 1 })
  const state = getFocusState(agent)
  assert.equal(isFocusProtected('bash', state), true)
  tickFocusState(agent) // expires
  assert.equal(getFocusState(agent), undefined)
  assert.equal(isFocusProtected('bash', getFocusState(agent)), false)
})

test('clearFocusState is idempotent', () => {
  const agent = fakeAgent()
  clearFocusState(agent) // no-op, no throw
  runContextFocusTool(agent, {})
  clearFocusState(agent)
  assert.equal(getFocusState(agent), undefined)
})

test('shouldForcePointerize: true only when over budget', () => {
  assert.equal(shouldForcePointerize(true), true)
  assert.equal(shouldForcePointerize(false), false)
})

test('reason is captured and truncated to 200 chars', () => {
  const agent = fakeAgent()
  const longReason = 'x'.repeat(500)
  runContextFocusTool(agent, { reason: longReason })
  assert.equal(getFocusState(agent)?.reason?.length, 200)
})
