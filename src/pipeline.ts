/**
 * Funnel orchestration: pointerize → (budget gate) → prune → compact → summarize.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/pipeline
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { isSurfaceOverBudget, withBudgetPressure } from './budget.ts'
import { compact } from './compact.ts'
import { withModelDerivedBudget } from './model-context.ts'
import { pointerize } from './pointerize.ts'
import { prune } from './prune.ts'
import { summarize, surfaceTextChars } from './summarize.ts'
import type { FunnelConfig, ResolvedFunnelConfig } from './types.ts'
import { resolveFunnelConfig } from './types.ts'

/** Stage counters. */
export interface FunnelResult {
  pointerized: number
  pruned: number
  compacted: number
  summarized: boolean
  /** True when surface exceeded soft budget after pointerize. */
  budgetPressure: boolean
  surfaceCharsAfterPointerize: number
  surfaceNodesAfterPointerize: number
  /** Model id used for context-limit lookup. */
  model: string
  /** Resolved context window (tokens). */
  contextLimit: number
  /** Effective surface char soft-cap after min(absolute, scaled). */
  effectiveBudgetChars: number
}

/** Optional extras for one funnel pass. */
export interface FunnelRunOptions {
  /** Pre-resolved knobs. When omitted, `config` (or defaults) is resolved. */
  resolved?: ResolvedFunnelConfig
  /** Raw knobs when `resolved` is omitted. */
  config?: FunnelConfig
  /** Whether `ctx.compaction` was visible (recorded on the placeholder only). */
  compactionAvailable?: boolean | undefined
}

/**
 * Run stages in order.
 * After pointerize, measure surface size; if over soft budget, tighten
 * prune/compact knobs for this pass only (no LLM).
 */
export function runFunnel(agent: Agent, turn: number, options: FunnelRunOptions = {}): FunnelResult {
  const base = options.resolved ?? resolveFunnelConfig(options.config)
  const derived = withModelDerivedBudget(base, agent.options?.model)
  const resolved = derived.config

  const pointerized = pointerize(agent, turn, resolved)

  const afterPtr = surfaceTextChars(agent)
  const budgetPressure = isSurfaceOverBudget(afterPtr, resolved)
  const effective = budgetPressure ? withBudgetPressure(resolved) : resolved

  // Under pressure, allow one more pointerize pass with lower minChars so
  // mid-size bodies still convert before aggressive prune.
  let pointerizedExtra = 0
  if (budgetPressure && effective.pointerizeMinChars < resolved.pointerizeMinChars) {
    pointerizedExtra = pointerize(agent, turn, effective)
  }

  const pruned = prune(agent, turn, effective)
  const compacted = compact(agent, turn, effective)
  const summarized = summarize(agent, turn, resolved, {
    compactionAvailable: options.compactionAvailable,
  })
  return {
    pointerized: pointerized + pointerizedExtra,
    pruned,
    compacted,
    summarized,
    budgetPressure,
    surfaceCharsAfterPointerize: afterPtr.chars,
    surfaceNodesAfterPointerize: afterPtr.nodes,
    model: derived.model,
    contextLimit: derived.contextLimit,
    effectiveBudgetChars: derived.derivedBudgetChars,
  }
}
