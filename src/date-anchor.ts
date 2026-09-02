/**
 * Low-frequency date anchor — inject an `[@MM-DD HH:MM]` user message when the
 * calendar day changes, so the model always has a fresh time reference no
 * matter where the incoming message came from (GUI input box sends text
 * verbatim with no date; IM/inbox carry their own; schedule fires carry none).
 *
 * The funnel pre-step runs before every model request, so this covers ALL
 * message sources uniformly: inject once per day-change, never per step
 * (contrast the old `dsh-time-context` which injected every step and churned
 * the prefix cache). This is the "date is an event, not an attribute" landing:
 * same idea as minimal's low-frequency `[@MM-DD HH:MM]` anchors on user/im
 * messages, but at the projection layer — a day-change detector instead of a
 * per-message formatter.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/date-anchor
 */

import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { eventAt } from './session-events.ts'

/** Wall-clock timezone for anchors (matches minimal POINTER_CARD_TZ). */
export const DATE_ANCHOR_TZ = 'Asia/Shanghai'

/** Anchor marker: `[@MM-DD HH:MM]` — same shape as minimal's dated timestamp. */
export const DATE_ANCHOR_PREFIX = '[@'

/** Injected user-message source marker so we can find/replace the old anchor. */
const ANCHOR_SOURCE = { kind: 'plugin', form: 'notice' } as const

/** Per-agent last injected calendar day (YYYY-MM-DD in DATE_ANCHOR_TZ). */
const lastAnchorDay = new WeakMap<Agent, string>()

/** Format a Date into the local-day calendar key (YYYY-MM-DD). */
export function dayKey(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: DATE_ANCHOR_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date) // en-CA yields YYYY-MM-DD
}

/** Format a Date into `[@MM-DD HH:MM]` (anchor body). */
export function formatDatedAnchor(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DATE_ANCHOR_TZ,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === t)?.value ?? ''
  return `[@${get('month')}-${get('day')} ${get('hour')}:${get('minute')}]`
}

/** Exact anchor shape: `[@MM-DD HH:MM]` (txyy review — narrow match). */
const ANCHOR_RE = /^\[@\d{2}-\d{2} \d{2}:\d{2}\]/

/** Locate the previously injected anchor's event seq, or undefined. */
function findPreviousAnchorSeq(agent: Agent): number | undefined {
  for (const seq of [...agent.session.surface.nodes]) {
    const event = eventAt(agent, seq)
    if (event?.type !== 'user/message') continue
    const text = userMessageText(event)
    if (ANCHOR_RE.test(text)) return seq
  }
  return undefined
}

/** Concatenated text of a user/message event (data IS the UserMessage). */
function userMessageText(event: SessionEvent<'user/message'>): string {
  const block = event.data.content[0]
  if (block?.type !== 'text') return ''
  return block.text
}

/**
 * Inject (or refresh) the date anchor when the calendar day changed since the
 * last injection. Replace the previous anchor in place so there is exactly one
 * visible `[@MM-DD HH:MM]` block; fall back to append if the old node was
 * shadowed. Idempotent within the same day — no per-step churn.
 *
 * @returns true when a new anchor was injected (day changed).
 */
export function injectDateAnchor(agent: Agent, now: Date = new Date()): boolean {
  const today = dayKey(now)
  const last = lastAnchorDay.get(agent)
  if (last === today) return false

  const text = formatDatedAnchor(now)
  const data = {
    role: 'user',
    content: [{ type: 'text', text }],
    source: ANCHOR_SOURCE,
    id: randomUUID(),
  } as never

  const previous = findPreviousAnchorSeq(agent)
  if (previous !== undefined) {
    try {
      agent.session.append('user/message', data, {
        surfaceOp: { op: 'replace', start: previous, end: previous },
        sourceEventSeqs: [previous],
      } as never)
      lastAnchorDay.set(agent, today)
      return true
    } catch {
      // fall through to append if the replace failed (e.g. shadowed)
    }
  }
  agent.session.append('user/message', data, { surfaceOp: 'append' } as never)
  lastAnchorDay.set(agent, today)
  return true
}

/** Test helper: reset per-agent anchor state. */
export function resetDateAnchorState(agent: Agent): void {
  lastAnchorDay.delete(agent)
}
