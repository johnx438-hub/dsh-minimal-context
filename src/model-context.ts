/**
 * Map provider model ids → context window size; derive surface budget chars.
 * Mirrors Minimal `budget.ts` MODEL_CONTEXT_LIMITS spirit (no Web UI plugin).
 *
 * @module @deepseek-ai/dsh-minimal-funnel/model-context
 */

import type { ResolvedFunnelConfig } from './types.ts'

/** Fallback when model unknown (align Minimal DEFAULT_CONTEXT_TOKENS). */
export const DEFAULT_CONTEXT_TOKENS = 200_000

/**
 * Official / commonly used context lengths (tokens).
 * Prefer exact keys; also match by suffix after `/`.
 */
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'deepseek-v4-flash': 1_000_000,
  'deepseek-v4-pro': 1_000_000,
  'deepseek/deepseek-v4-flash': 1_000_000,
  'deepseek/deepseek-v4-pro': 1_000_000,
  'deepseek/deepseek-chat': 1_000_000,
  'deepseek/deepseek-reasoner': 1_000_000,
  'deepseek-chat': 1_000_000,
  'deepseek-reasoner': 1_000_000,
  'qwen3.6-27b': 262_000,
  'qwen3.6-14b': 128_000,
  'qwen/qwen3.8-27': 262_000,
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
}

/** Normalize provider/model strings for table lookup. */
export function normalizeModelId(model: string | undefined | null): string {
  if (!model) return ''
  return model.trim().toLowerCase()
}

/** Resolve context token limit for a model id. */
export function resolveContextLimit(model: string | undefined | null): number {
  const id = normalizeModelId(model)
  if (!id) return DEFAULT_CONTEXT_TOKENS
  if (MODEL_CONTEXT_LIMITS[id] != null) return MODEL_CONTEXT_LIMITS[id]!
  const slash = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id
  if (MODEL_CONTEXT_LIMITS[slash] != null) return MODEL_CONTEXT_LIMITS[slash]!
  // Fuzzy: deepseek v4 family
  if (slash.includes('deepseek') && slash.includes('v4')) return 1_000_000
  if (slash.includes('deepseek')) return 1_000_000
  return DEFAULT_CONTEXT_TOKENS
}

/**
 * Soft surface char budget from model window:
 * `min(absoluteCap, floor(contextLimit * ratio * charsPerToken))`
 *
 * Large windows (1M) stay capped by `surfaceBudgetChars` so we don't wait
 * until hundreds of kB of tool junk accumulate. Small windows scale down.
 */
export function deriveSurfaceBudgetChars(
  contextLimit: number,
  config: ResolvedFunnelConfig,
): number {
  const scaled = Math.floor(
    contextLimit * config.surfaceBudgetContextRatio * config.surfaceBudgetCharsPerToken,
  )
  const floor = config.surfaceBudgetCharsMin
  const derived = Math.max(floor, scaled)
  return Math.min(config.surfaceBudgetChars, derived)
}

/** Apply model-derived char budget onto a resolved config copy. */
export function withModelDerivedBudget(
  base: ResolvedFunnelConfig,
  model: string | undefined | null,
): {
  config: ResolvedFunnelConfig
  model: string
  contextLimit: number
  derivedBudgetChars: number
} {
  const modelId = normalizeModelId(model) || '(default)'
  const contextLimit = resolveContextLimit(model)
  const derivedBudgetChars = deriveSurfaceBudgetChars(contextLimit, base)
  return {
    model: modelId,
    contextLimit,
    derivedBudgetChars,
    config: {
      ...base,
      surfaceBudgetChars: derivedBudgetChars,
    },
  }
}
