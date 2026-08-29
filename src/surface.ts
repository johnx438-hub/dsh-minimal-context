/**
 * Shared surface helpers for prune / compact (004 replace protocol).
 *
 * @module @deepseek-ai/dsh-minimal-funnel/surface
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-compaction'
import { estimateMessage } from './vendor/estimate.js'
import { calibratedEstimate } from './token-calibrator.ts'

/** Same middle marker as `dsh-compaction-tool-result-pruner`. */
export const PRUNE_MARKER = '\n\n[... tool result middle pruned ...]\n\n'

const CARD_PREFIX = /^\[action:([^\]]+)\] turn=(\d+)/

/** Concatenate text blocks from one `tool/result` event. */
export function toolResultText(event: SessionEvent<'tool/result'>): string {
  const block = event.data.message.content[0]
  if (block === undefined || block.type !== 'tool-result') return ''
  const parts: string[] = []
  for (const inner of block.content) {
    if (inner.type === 'text') parts.push(inner.text)
  }
  return parts.join('')
}

/** Unicode code-point length (same basis as the Harness pruner). */
export function codePointLength(text: string): number {
  return Array.from(text).length
}

/** action_id from the tool-result envelope (Harness callId). */
export function actionIdOf(event: SessionEvent<'tool/result'>): string {
  return String(event.data.message.source.callId)
}

/** True when the body is a 004 pointer card (or a compacted descendant). */
export function isPointerCardText(text: string): boolean {
  const trimmed = text.trim()
  return CARD_PREFIX.test(trimmed) || trimmed.includes('recall=recall_query')
}

/** True when the card was already downgraded to the short stand-in. */
export function isCompactedCardText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.includes(' compacted') || trimmed.startsWith('[compacted')
}

/** True when the body already has the Harness prune middle marker. */
export function isPrunedText(text: string): boolean {
  return text.includes('[... tool result middle pruned ...]')
}

/** Short stand-in written by compact (and by prune of an oversized card). */
export function renderCompactedCard(actionId: string, turn: number): string {
  return `[action:${actionId}] turn=${turn} compacted`
}

/**
 * Head/tail a still-full over-budget body. Returns null when already in budget
 * or when the replacement would not shrink.
 */
export function headTailPrune(
  text: string,
  headChars: number,
  tailChars: number,
  thresholdChars: number,
): string | null {
  const points = Array.from(text)
  if (points.length <= thresholdChars) return null
  const head = Math.min(headChars, points.length)
  const tail = Math.min(tailChars, Math.max(0, points.length - head))
  const next = points.slice(0, head).join('') + PRUNE_MARKER + points.slice(points.length - tail).join('')
  if (codePointLength(next) >= points.length) return null
  return next
}

/**
 * 004 protocol: `compaction/prune` shadow-price then `tool/result` replace.
 * Only `content` changes. Original body stays in the log (off the surface).
 */
export function replaceToolResult(
  agent: Agent,
  seq: number,
  event: SessionEvent<'tool/result'>,
  newText: string,
): void {
  const result = event.data.message.content[0]
  const message = freezeMessage<ToolResultMessage>({
    ...event.data.message,
    content: [{
      ...result,
      content: [{ type: 'text', text: newText }],
    }] as [typeof result],
  })
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
}

/** Current-surface `tool/result` nodes (snapshot, same as pointerize/pruner). */
export function surfaceToolResults(
  agent: Agent,
): { seq: number; event: SessionEvent<'tool/result'> }[] {
  const out: { seq: number; event: SessionEvent<'tool/result'> }[] = []
  for (const seq of [...agent.session.surface.nodes]) {
    const event = agent.session.events[seq]
    if (event?.type === 'tool/result') out.push({ seq, event })
  }
  return out
}
