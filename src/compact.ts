/**
 * Stage 2: downgrade older pointer cards to a shorter stand-in.
 * Caps how many full-ish cards stay per older turn. Same 004 protocol.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/compact
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ResolvedFunnelConfig } from './types.ts'
import {
  actionIdOf,
  isCompactedCardText,
  isPointerCardText,
  renderCompactedCard,
  replaceToolResult,
  surfaceToolResults,
  toolResultText,
} from './surface.ts'

/**
 * Keep up to `maxFullCardsPerTurn` newest full-ish cards per older turn;
 * downgrade the older extras (oldest first), capped by `maxCompactPerStep`.
 * @returns number of cards downgraded.
 */
export function compact(agent: Agent, currentTurn: number, config: ResolvedFunnelConfig): number {
  if (currentTurn <= 1) return 0
  if (config.maxCompactPerStep <= 0) return 0

  const byTurn = new Map<number, { seq: number; event: SessionEvent<'tool/result'> }[]>()
  for (const item of surfaceToolResults(agent)) {
    if (item.event.data.turn >= currentTurn) continue
    const text = toolResultText(item.event)
    if (!isPointerCardText(text) || isCompactedCardText(text)) continue
    const list = byTurn.get(item.event.data.turn)
    if (list === undefined) byTurn.set(item.event.data.turn, [item])
    else list.push(item)
  }

  const extras: { seq: number; event: SessionEvent<'tool/result'> }[] = []
  const turns = [...byTurn.keys()].sort((a, b) => a - b)
  for (const turn of turns) {
    const cards = byTurn.get(turn)
    if (cards === undefined) continue
    if (cards.length <= config.maxFullCardsPerTurn) continue
    extras.push(...cards.slice(0, cards.length - config.maxFullCardsPerTurn))
  }

  const budget = extras.slice(0, config.maxCompactPerStep)
  let count = 0
  for (const { seq, event } of budget) {
    const next = renderCompactedCard(actionIdOf(event), event.data.turn)
    const text = toolResultText(event)
    if (next === text) continue
    replaceToolResult(agent, seq, event, next)
    count += 1
  }
  return count
}
