import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveFunnelConfig } from '../src/types.ts'

test('keepRecentTurns defaults to 2', () => {
  const cfg = resolveFunnelConfig()
  assert.equal(cfg.keepRecentTurns, 2)
})

test('keepRecentTurns configurable', () => {
  const cfg = resolveFunnelConfig({ keepRecentTurns: 5 })
  assert.equal(cfg.keepRecentTurns, 5)
})

test('keepRecentTurns accepts 0 (disable protection)', () => {
  const cfg = resolveFunnelConfig({ keepRecentTurns: 0 })
  assert.equal(cfg.keepRecentTurns, 0)
})

test('recent protection boundary math', () => {
  const cfg = resolveFunnelConfig({ keepRecentTurns: 2 })
  const currentTurn = 10
  // turn 10, 9 are protected (>= currentTurn, > currentTurn-2)
  assert.equal(10 > currentTurn - cfg.keepRecentTurns, true) // 10 > 8 → protected
  assert.equal(9 > currentTurn - cfg.keepRecentTurns, true)  // 9 > 8 → protected
  assert.equal(8 > currentTurn - cfg.keepRecentTurns, false) // 8 > 8 → NOT protected
  assert.equal(7 > currentTurn - cfg.keepRecentTurns, false) // 7 > 8 → NOT protected
})
