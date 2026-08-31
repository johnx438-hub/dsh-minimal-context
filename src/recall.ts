/**
 * Model-facing recall_query: return the original (cold) tool/result body
 * from the append-only session log. The log is the cold store. No vector DB.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { renderDiffAudit } from './audit.ts'
import { toolResultText } from './surface.ts'

/** Harness tool name. Matches the pointer-card line `recall=recall_query(...)`. */
export const RECALL_QUERY_NAME = 'recall_query'

/**
 * Walk the append-only log for the original pre-replace tool/result body.
 * Prefer `funnel/pointer-card.sourceSeq` when present (legacy sessions), else
 * the first non-replacement `tool/result` with this callId.
 *
 * New funnel writes no longer emit `funnel/pointer-card` (history-load safety);
 * recall still works via the callId fallback.
 */
export function recallOriginalText(agent: Agent, actionId: string): string | undefined {
  const wanted = String(actionId)
  for (const event of agent.session.events) {
    if (event.type !== 'funnel/pointer-card') continue
    const data = event.data as {
      action_id?: string
      callId?: string
      sourceSeq?: number
    }
    if (data.action_id !== wanted && data.callId !== wanted) continue
    if (typeof data.sourceSeq === 'number') {
      const at = agent.session.events[data.sourceSeq]
      if (at?.type === 'tool/result' && !isReplacementSurfaceEvent(at)) {
        const text = toolResultText(at)
        if (text.length > 0) return text
      }
    }
    break
  }
  for (const event of agent.session.events) {
    if (event.type !== 'tool/result') continue
    if (String(event.data.message.source.callId) !== wanted) continue
    if (isReplacementSurfaceEvent(event)) continue
    const text = toolResultText(event)
    if (text.length > 0) {
      // L2 recall: if the event still carries meta.diffs (L1 audit source) but
      // the surface body was display-compacted, re-render the full audit block
      // so recall returns the complete diff, not the [edit_display compacted]
      // stand-in or the harness's short "updated successfully" line.
      const audit = renderDiffAudit(event)
      if (audit !== null) return audit
      return text
    }
  }
  return undefined
}

const DESCRIPTION =
  'Recall the original full tool result for a pointer-card action_id. '
  + 'The session log is the cold store: this returns the pre-replace body, '
  + 'not the pointer card or a compacted stand-in.'

/** Register `recall_query` on `ctx.tools` when the registry is composed. */
export function registerRecallQuery(ctx: Context): void {
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(defineTool({
      name: RECALL_QUERY_NAME,
      description: DESCRIPTION,
      parameters: {
        action_id: {
          type: 'string',
          required: true,
          description: 'Pointer-card action_id (Harness callId of the original tool result).',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        if (!exec.agent) {
          throw new Error('recall_query requires an owning agent session')
        }
        const text = recallOriginalText(exec.agent, args.action_id)
        if (text === undefined) {
          throw new Error(
            `recall_query: no original tool/result for action_id=${JSON.stringify(args.action_id)}`,
          )
        }
        return Promise.resolve(text)
      },
      presentCall: args => ({
        card: 'generic',
        title: 'Recall tool result',
        kind: 'read',
        rawInput: args.action_id,
      }),
    }))
  })
}
