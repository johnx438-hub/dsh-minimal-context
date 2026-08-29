import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { shouldPointerize } from '../src/eligibility.ts'
import { headTailPrune, isPointerCardText } from '../src/surface.ts'
import { resolveFunnelConfig } from '../src/types.ts'

describe('funnel eligibility (Phase B)', () => {
  const cfg = resolveFunnelConfig()

  it('skips small unknown-tool bodies under minChars', () => {
    assert.equal(shouldPointerize('unknown', 'x'.repeat(100), cfg), false)
    assert.equal(shouldPointerize('unknown', 'x'.repeat(400), cfg), true)
  })

  it('never pointerizes recall_query', () => {
    assert.equal(
      shouldPointerize('recall_query', 'Z'.repeat(50_000), cfg),
      false,
    )
  })

  it('pointerizes large bash output', () => {
    assert.equal(shouldPointerize('bash', 'Z'.repeat(800), cfg), true)
    assert.equal(shouldPointerize('bash', 'short', cfg), false)
  })

  it('skips error: prefixes', () => {
    assert.equal(
      shouldPointerize('bash', 'error: boom\n' + 'Z'.repeat(5000), cfg),
      false,
    )
  })

  it('headTailPrune shrinks over threshold', () => {
    const big = 'H'.repeat(10_000) + 'T'.repeat(10_000)
    const next = headTailPrune(big, 4096, 1024, 8192)
    assert.ok(next)
    assert.ok(next!.length < big.length)
    assert.ok(next!.includes('tool result middle pruned'))
  })

  it('detects pointer card text', () => {
    const card = [
      '[action:call_1] turn=1',
      'tool=bash chars=100 sha256=abc',
      'recall=recall_query(action_id="call_1")',
    ].join('\n')
    assert.equal(isPointerCardText(card), true)
  })
})
