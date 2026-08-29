/**
 * Stage 3: threshold-triggered summarize.
 * Does not call `ctx.compaction`. Emits an honest `funnel/summary-placeholder`.
 *
 * 006 decision: the seam is not safe to invoke from this pre-step.
 * `compactNow` requires idle `runMaintenance` (we are in a live turn).
 * `compactIfNeeded` is already owned by compaction-basic on the same
 * `agent/pre-step` and is a token-pressure LLM pass (`summarizeWithLlm` →
 * `ctx.llm.stream`), not this stage's char/node gate. A second call is
 * re-entry of that policy. `compactRegion` always runs the summarizer hook.
 * Do not fake `compaction/summary`. Do not fire `ctx.llm.stream` here.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/summarize
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedFunnelConfig } from './types.ts'
import { toolResultText } from './surface.ts'

export interface SummarizeOptions {
  /** True when `ctx.get('compaction')` resolved (seam present, not invoked). */
  compactionAvailable?: boolean | undefined
}

/** Concatenated model-visible text on the current surface (for summarize + debug). */
export function surfaceTextChars(agent: Agent): { nodes: number; chars: number } {
  const nodes = [...agent.session.surface.nodes]
  let chars = 0
  for (const seq of nodes) {
    const event = agent.session.events[seq]
    if (event === undefined) continue
    if (event.type === 'tool/result') {
      chars += toolResultText(event).length
      continue
    }
    let content: unknown
    if (event.type === 'user/message') content = event.data.content
    else if (event.type === 'assistant/message') content = event.data.message.content
    else continue
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block !== null && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
        chars += block.text.length
      }
    }
  }
  return { nodes: nodes.length, chars }
}

/**
 * Threshold check only — does **not** append `funnel/summary-placeholder`.
 *
 * Custom session event types break history load unless marked `ignorable`, and
 * current `Session.append` cannot set that flag for non-surface events. Keep
 * summarize as a no-op side-effect stage (still returns whether the threshold
 * would have fired for metrics / tests). Never calls `ctx.compaction`.
 */
export function summarize(
  agent: Agent,
  currentTurn: number,
  config: ResolvedFunnelConfig,
  _options: SummarizeOptions = {},
): boolean {
  if (currentTurn <= 1) return false

  const { nodes, chars } = surfaceTextChars(agent)
  if (chars < config.summarizeMinChars && nodes < config.summarizeMinNodes) {
    return false
  }
  return true
}
