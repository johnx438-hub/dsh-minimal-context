/**
 * Light surface budget gate — when the model-visible surface is oversized,
 * tighten prune/compact (no LLM). Correlate with DSH Web cache hit / input tokens.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/budget
 */

import type { ResolvedFunnelConfig } from './types.ts'

/** Snapshot used to decide budget pressure. */
export interface SurfaceBudgetSnapshot {
  chars: number
  nodes: number
}

/**
 * True when surface exceeds char and/or node soft caps.
 * Either cap alone can trip pressure (OR).
 */
export function isSurfaceOverBudget(
  snap: SurfaceBudgetSnapshot,
  config: ResolvedFunnelConfig,
): boolean {
  if (!config.surfaceBudgetEnabled) return false
  if (snap.chars >= config.surfaceBudgetChars) return true
  if (snap.nodes >= config.surfaceBudgetNodes) return true
  return false
}

/**
 * Return a knobs copy with more aggressive prune/compact (and slightly
 * lower pointerize floor). Does not mutate `base`.
 */
export function withBudgetPressure(base: ResolvedFunnelConfig): ResolvedFunnelConfig {
  return {
    ...base,
    pointerizeMinChars: Math.min(
      base.pointerizeMinChars,
      base.budgetPointerizeMinChars,
    ),
    pruneThresholdChars: Math.min(
      base.pruneThresholdChars,
      base.budgetPruneThresholdChars,
    ),
    pruneHeadChars: Math.min(base.pruneHeadChars, base.budgetPruneHeadChars),
    pruneTailChars: Math.min(base.pruneTailChars, base.budgetPruneTailChars),
    maxFullCardsPerTurn: Math.min(
      base.maxFullCardsPerTurn,
      base.budgetMaxFullCardsPerTurn,
    ),
    maxCompactPerStep: Math.max(
      base.maxCompactPerStep,
      base.budgetMaxCompactPerStep,
    ),
  }
}
