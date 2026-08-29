import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { isSurfaceOverBudget, withBudgetPressure } from '../src/budget.ts'
import { resolveFunnelConfig } from '../src/types.ts'

describe('surface budget gate', () => {
  const base = resolveFunnelConfig()

  it('trips on chars OR nodes', () => {
    assert.equal(
      isSurfaceOverBudget({ chars: base.surfaceBudgetChars, nodes: 1 }, base),
      true,
    )
    assert.equal(
      isSurfaceOverBudget({ chars: 10, nodes: base.surfaceBudgetNodes }, base),
      true,
    )
    assert.equal(
      isSurfaceOverBudget({ chars: 10, nodes: 1 }, base),
      false,
    )
  })

  it('respects surfaceBudgetEnabled=false', () => {
    const off = resolveFunnelConfig({ surfaceBudgetEnabled: false })
    assert.equal(
      isSurfaceOverBudget(
        { chars: 9_999_999, nodes: 9_999 },
        off,
      ),
      false,
    )
  })

  it('withBudgetPressure tightens prune/compact', () => {
    const tight = withBudgetPressure(base)
    assert.ok(tight.pruneThresholdChars <= base.pruneThresholdChars)
    assert.ok(tight.pruneHeadChars <= base.pruneHeadChars)
    assert.ok(tight.maxFullCardsPerTurn <= base.maxFullCardsPerTurn)
    assert.ok(tight.maxCompactPerStep >= base.maxCompactPerStep)
    assert.ok(tight.pointerizeMinChars <= base.pointerizeMinChars)
  })
})
