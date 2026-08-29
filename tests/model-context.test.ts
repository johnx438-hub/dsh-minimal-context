import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  deriveSurfaceBudgetChars,
  resolveContextLimit,
} from '../src/model-context.ts'
import { resolveFunnelConfig } from '../src/types.ts'

describe('model-derived surface budget', () => {
  const cfg = resolveFunnelConfig()

  it('maps deepseek-v4 to 1M', () => {
    assert.equal(resolveContextLimit('deepseek-v4-flash'), 1_000_000)
    assert.equal(resolveContextLimit('deepseek/deepseek-v4-pro'), 1_000_000)
  })

  it('1M window stays capped by absolute surfaceBudgetChars', () => {
    const derived = deriveSurfaceBudgetChars(1_000_000, cfg)
    // scaled = 1e6 * 0.08 * 4 = 320_000 → min(100_000, 320_000) = 100_000
    assert.equal(derived, 100_000)
  })

  it('128k window scales below absolute cap', () => {
    const derived = deriveSurfaceBudgetChars(128_000, cfg)
    // 128k * 0.08 * 4 = 40_960
    assert.equal(derived, 40_960)
  })

  it('respects chars min floor', () => {
    const tiny = resolveFunnelConfig({
      surfaceBudgetCharsMin: 25_000,
      surfaceBudgetChars: 100_000,
    })
    const derived = deriveSurfaceBudgetChars(8_000, tiny)
    // scaled = 8000*0.08*4 = 2560 → max(25000, 2560) = 25000 → min(100000, 25000)
    assert.equal(derived, 25_000)
  })
})
