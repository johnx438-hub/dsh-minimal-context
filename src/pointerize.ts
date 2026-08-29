/**
 * Stage 0: emit durable pointer cards and take the original tool/result
 * off the model surface (compaction-prune shadow-price then replace).
 *
 * @module @deepseek-ai/dsh-minimal-funnel/pointerize
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only: the `compaction/prune` SessionEventMap merge (shadow-price event).
import type {} from '@deepseek-ai/dsh-compaction'
import { shouldPointerize } from './eligibility.ts'
import { isPointerCardText } from './surface.ts'
import { buildToolPreview, renderCardWithPreview } from './preview.ts'
import {
  getFocusState,
  isFocusProtected,
  shouldForcePointerize,
  tickFocusState,
} from './context-focus.ts'
import { isSurfaceOverBudget } from './budget.ts'
import { surfaceTextChars } from './summarize.ts'
import { estimateMessage } from './vendor/estimate.js'
import { calibratedEstimate } from './token-calibrator.ts'
import type { FunnelPointerCardData, ResolvedFunnelConfig } from './types.ts'
import { resolveFunnelConfig } from './types.ts'

/** sha256 hex of a tool-result body (card fingerprint). */
function fingerprintText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** Concatenate text blocks from one `tool/result` event. */
function toolResultText(event: SessionEvent<'tool/result'>): string {
  const block = event.data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return ''
  const parts: string[] = []
  for (const inner of block.content) {
    if (inner.type === 'text') parts.push(inner.text)
  }
  return parts.join('')
}

/** Model-facing pointer card (turn, tool+fingerprint, recall handle). */
function renderPointerCard(data: FunnelPointerCardData): string {
  return [
    `[action:${data.action_id}] turn=${data.turn}`,
    `tool=${data.tool} chars=${data.chars} sha256=${data.fingerprint}`,
    `recall=recall_query(action_id="${data.action_id}")`,
  ].join('\n')
}

/**
 * Pointerize prior-turn tool results that are still on the current surface.
 *
 * Uses only known harness event types (`compaction/prune` + `tool/result`
 * replace). We intentionally do **not** append `funnel/pointer-card`: out-of-repo
 * event types are absent from `KNOWN_SESSION_EVENT_TYPES`, and `Session.append`
 * cannot set `ignorable: true` on non-surface events in current dsh-session —
 * writing them makes history unloadable (`SessionFormatUnsupportedError`).
 *
 * Cold recall walks the append-only log for the original non-replacement
 * `tool/result` by callId (see `recall.ts`).
 *
 * Turn 1 is a no-op.
 * @returns number of newly pointerized (and replaced) tool results.
 */
export function pointerize(
  agent: Agent,
  currentTurn: number,
  config?: ResolvedFunnelConfig,
): number {
  if (currentTurn <= 1) return 0
  const resolved = config ?? resolveFunnelConfig()

  const toolNames = new Map<string, string>()
  const toolArgs = new Map<string, Record<string, unknown>>()
  for (const event of agent.session.events) {
    if (event.type === 'tool/call') {
      toolNames.set(event.data.callId, event.data.name)
      const args = event.data.arguments
      if (typeof args === 'object' && args !== null) {
        toolArgs.set(event.data.callId, args as Record<string, unknown>)
      }
    }
  }

  const candidates: { seq: number; event: SessionEvent<'tool/result'> }[] = []
  for (const seq of [...agent.session.surface.nodes]) {
    const event = agent.session.events[seq]
    if (event?.type !== 'tool/result') continue
    if (event.data.turn >= currentTurn) continue
    candidates.push({ seq, event })
  }

  let count = 0
  const focusState = getFocusState(agent)
  const { nodes: surfaceNodes, chars: surfaceChars } = surfaceTextChars(agent)
  const overBudget = isSurfaceOverBudget(
    { chars: surfaceChars, nodes: surfaceNodes },
    resolved,
  )
  const forceCards = shouldForcePointerize(overBudget)
  for (const { seq, event } of candidates) {
    const callId = event.data.message.source.callId
    const actionId = String(callId)
    const text = toolResultText(event)
    if (text.length === 0) continue
    // Recent-layer protection: keep the last `keepRecentTurns` turns inline
    // (mirrors minimal recent_pct full action blocks), unless the surface is
    // over budget — high pressure always wins.
    if (
      !forceCards &&
      event.data.turn > currentTurn - resolved.keepRecentTurns
    ) {
      continue
    }
    // Already a card (or compacted card) on the surface — skip.
    if (isPointerCardText(text)) continue
    const tool = toolNames.get(callId) ?? 'unknown'
    if (!shouldPointerize(tool, text, resolved)) continue
    // context_focus keep-boost: skip pointerization while a matching focus is
    // active — unless the surface is over budget (high pressure always wins).
    if (!forceCards && isFocusProtected(tool, focusState)) continue

    const payload: FunnelPointerCardData = {
      turn: event.data.turn,
      tool,
      fingerprint: fingerprintText(text),
      action_id: actionId,
      callId: actionId,
      sourceSeq: event.seq,
      chars: text.length,
    }

    const cardLines = renderPointerCard(payload).split('\n')
    const preview = buildToolPreview(
      tool,
      text,
      toolArgs.get(callId) ?? {},
    )
    const cardText = renderCardWithPreview(cardLines, preview)
    const result = event.data.message.content[0]
    const message = freezeMessage<ToolResultMessage>({
      ...event.data.message,
      content: [{
        ...result,
        content: [{ type: 'text', text: cardText }],
      }] as [typeof result],
    })
    // Shadow-price protocol: metering event and replacement are appended
    // synchronously adjacent so pure token-meter consumers can subtract
    // the shadowed node without retaining per-node state.
    agent.session.append('compaction/prune', {
      shadowedRange: { start: seq, end: seq },
      shadowedSeqs: [seq],
      shadowedTokenCount: calibratedEstimate(estimateMessage(event.data.message)),
    })
    agent.session.append('tool/result', {
      ...event.data,
      message,
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    count += 1
  }
  // context_focus TTL: tick once per turn-end pass; expired state is dropped.
  tickFocusState(agent)
  return count
}
