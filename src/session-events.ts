/**
 * Session event access — compatible adapter across dsh-session versions.
 *
 * rc.2 exposes `session.events` (getter → array); alpha.4 replaced it with
 * explicit snapshot methods (`eventAt(seq)` / `snapshotEvents()`) — a data
 * isolation improvement (getter exposed a mutable reference; snapshots are
 * frozen copies). This adapter picks whichever the runtime provides so the
 * funnel works on both without a version fork.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/session-events
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Read one event by seq (rc.2: events[seq]; alpha.4: eventAt(seq)). */
export function eventAt(agent: Agent, seq: number): SessionEvent | undefined {
  const s = agent.session as unknown as {
    eventAt?: (seq: number) => SessionEvent | undefined
    events?: readonly SessionEvent[]
  }
  if (typeof s.eventAt === 'function') return s.eventAt(seq)
  return s.events?.[seq]
}

/** Read all events (rc.2: events; alpha.4: snapshotEvents()). */
export function allEvents(agent: Agent): readonly SessionEvent[] {
  const s = agent.session as unknown as {
    snapshotEvents?: () => readonly SessionEvent[]
    events?: readonly SessionEvent[]
  }
  if (typeof s.snapshotEvents === 'function') return s.snapshotEvents()
  return s.events ?? []
}
