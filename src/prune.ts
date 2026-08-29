/**
 * Stage 1: shrink still-large prior-turn surface tool/result bodies.
 * Same 004 replace protocol. Current turn is never touched.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/prune
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ResolvedFunnelConfig } from './types.ts'
import {
  actionIdOf,
  codePointLength,
  headTailPrune,
  isCompactedCardText,
  isPointerCardText,
  isPrunedText,
  renderCompactedCard,
  replaceToolResult,
  surfaceToolResults,
  toolResultText,
} from './surface.ts'

/**
 * Prune prior-turn surface tool/results that are still over the char threshold.
 * Already-carded oversized bodies become the short compacted stand-in.
 * Still-full bodies keep head+tail with the Harness prune marker.
 * Cold/full text stays in the log (replace, not delete).
 * @returns number of surface replacements landed.
 */
export function prune(agent: Agent, currentTurn: number, config: ResolvedFunnelConfig): number {
  if (currentTurn <= 1) return 0

  const candidates = surfaceToolResults(agent)
  let count = 0
  for (const { seq, event } of candidates) {
    if (event.data.turn >= currentTurn) continue
    const text = toolResultText(event)
    if (codePointLength(text) <= config.pruneThresholdChars) continue
    if (isPrunedText(text) || isCompactedCardText(text)) continue

    let next: string | null
    if (isPointerCardText(text)) {
      next = renderCompactedCard(actionIdOf(event), event.data.turn)
      if (codePointLength(next) >= codePointLength(text)) continue
    } else {
      next = headTailPrune(text, config.pruneHeadChars, config.pruneTailChars, config.pruneThresholdChars)
    }
    if (next === null) continue
    replaceToolResult(agent, seq, event, next)
    count += 1
  }
  return count
}
