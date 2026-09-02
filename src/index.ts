/**
 * dsh-minimal-context — the minimal-agent context funnel as a standalone
 * plugin. Pre-step runs pointerize → prune → compact → summarize.
 * Pointerize/prune/compact replace prior-turn `tool/result` on the surface
 * (card / truncated body). Does not append custom `funnel/*` session events.
 * Summarize is threshold-only (non-LLM). `recall_query` reads cold log bodies.
 * Set `MINIMAL_FUNNEL_DEBUG=1` for per-turn surface stats on stderr.
 *
 * Split from `@deepseek-ai/dsh-minimal-funnel` (2026-08-29): this package
 * carries ONLY the context pipeline + its two model tools
 * (`recall_query`, `context_focus`). Worker orchestration
 * (`session_create` / `persona_list` / `delegate_task` / tool-nudge) lives in
 * the sibling package. Zero cross-dependency between the two.
 *
 * @module dsh-minimal-context
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { runFunnel } from './pipeline.ts'
import { injectDateAnchor } from './date-anchor.ts'
import { surfaceTextChars } from './summarize.ts'
import { registerRecallQuery } from './recall.ts'
import { registerContextFocus } from './context-focus.ts'
import { getCalibrator, readInputTokensFromUsage } from './token-calibrator.ts'
import {
  extractTaskSummaries,
  selectTaskLayers,
  buildTaskSummaryMessage,
  isTaskSummaryMessage,
  shouldInjectTaskSummary,
} from './task-summary.ts'
import type { FunnelConfig } from './types.ts'

export type * from './types.ts'
export { resolveFunnelConfig, FUNNEL_DEFAULTS } from './types.ts'
export { shouldPointerize, TOOL_RULES } from './eligibility.ts'
export { isSurfaceOverBudget, withBudgetPressure } from './budget.ts'
export {
  deriveSurfaceBudgetChars,
  resolveContextLimit,
  withModelDerivedBudget,
} from './model-context.ts'
export { runFunnel } from './pipeline.ts'
export { recallOriginalText, RECALL_QUERY_NAME, registerRecallQuery } from './recall.ts'
export { CONTEXT_FOCUS_TOOL, registerContextFocus } from './context-focus.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'minimal-context'

/** The agent registry that owns pre-step processing. Tools is optional (see apply). */
export const inject = ['agents']

/** Optional conservative knobs. Invalid values fail plugin load. */
export interface Config extends FunnelConfig {}

/** Schemastery validation for {@link Config}. */
export const Config: z<Config> = z.object({
  pointerizeMinChars: z.number().step(1).min(1).default(400),
  pointerizeNeverTools: z.array(z.string()).default(['skill', 'recall_query']),
  pointerizeNeverPrefixes: z.array(z.string()).default([]),
  pruneThresholdChars: z.number().step(1).min(1),
  pruneHeadChars: z.number().step(1).min(0),
  pruneTailChars: z.number().step(1).min(0),
  maxFullCardsPerTurn: z.number().step(1).min(0),
  maxCompactPerStep: z.number().step(1).min(0),
  summarizeMinChars: z.number().step(1).min(1),
  summarizeMinNodes: z.number().step(1).min(1),
  surfaceBudgetEnabled: z.boolean().default(true),
  surfaceBudgetChars: z.number().step(1).min(1).default(100_000),
  surfaceBudgetNodes: z.number().step(1).min(1).default(80),
  surfaceBudgetContextRatio: z.number().min(0.001).max(1).default(0.08),
  surfaceBudgetCharsPerToken: z.number().min(1).max(16).default(4),
  surfaceBudgetCharsMin: z.number().step(1).min(1).default(20_000),
  budgetPointerizeMinChars: z.number().step(1).min(1).default(300),
  budgetPruneThresholdChars: z.number().step(1).min(1).default(4096),
  budgetPruneHeadChars: z.number().step(1).min(0).default(2048),
  budgetPruneTailChars: z.number().step(1).min(0).default(512),
  budgetMaxFullCardsPerTurn: z.number().step(1).min(0).default(1),
  budgetMaxCompactPerStep: z.number().step(1).min(0).default(40),
})

/** Whether the compaction service is on this context (not required). */
function compactionAvailable(ctx: Context): boolean {
  try {
    return ctx.get('compaction') !== undefined
  } catch {
    return false
  }
}

/**
 * Register `recall_query` when `ctx.tools` is composed, and a prepended
 * pre-step listener for the lifetime of `ctx`. Delegates first. On enter,
 * runs the funnel (session side effects). Does not append an extra plugin
 * user/message beyond the TaskSummary notice.
 */
export function apply(ctx: Context, config: Config): void {
  registerRecallQuery(ctx)
  registerContextFocus(ctx)
  const debug = process.env.MINIMAL_FUNNEL_DEBUG === '1'
  // Token calibrator: observe usage chunks appended to the session log since
  // the last pre-step, pairing local surface estimate with API inputTokens.
  const calibrator = getCalibrator()
  const lastUsageSeq = new WeakMap<object, number>()
  const observeUsage = (agent: Agent): void => {
    const since = lastUsageSeq.get(agent) ?? 0
    const { chars } = surfaceTextChars(agent)
    let maxSeq = since
    for (const event of agent.session.events) {
      if (event.type !== 'assistant/chunk') continue
      const chunk = event.data.chunk as { type?: string; usage?: unknown } | undefined
      if (chunk?.type !== 'usage') continue
      if (event.seq <= since) continue
      const actual = readInputTokensFromUsage(chunk.usage)
      if (actual !== undefined && chars > 0) calibrator.observe(chars, actual)
      if (event.seq > maxSeq) maxSeq = event.seq
    }
    lastUsageSeq.set(agent, maxSeq)
  }
  // TaskSummary injection: only when there is real memory loss to anchor
  // against (over budget, or the funnel actually compressed something since
  // the last injection and the interval elapsed). The new summary replaces
  // the previous injected one in place when possible, so at most one
  // [TaskSummary] block is ever visible — no stacking noise.
  const lastSummaryTurn = new WeakMap<object, number>()
  const findPreviousTaskSummarySeq = (agent: Agent): number | undefined => {
    const events = agent.session.events as SessionEvent[]
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event.type !== 'user/message') continue
      if (!isTaskSummaryMessage(event)) continue
      const source = (event.data as { source?: { kind?: string } }).source
      if (source?.kind !== 'plugin') continue
      return event.seq
    }
    return undefined
  }
  const maybeInjectTaskSummary = (
    agent: Agent,
    turn: number,
    overBudget: boolean,
    didCompact: boolean,
    interval: number,
  ): void => {
    const last = lastSummaryTurn.get(agent) ?? -Infinity
    if (!shouldInjectTaskSummary({
      overBudget, didCompact, turn, lastInjectionTurn: last, interval,
    })) return
    // Nothing to summarize (no tool activity at all) → skip.
    const docs = extractTaskSummaries(agent)
    if (docs.length === 0) return
    const layers = selectTaskLayers(docs)
    const message = buildTaskSummaryMessage(layers)
    const data = {
      role: 'user',
      content: [{ type: 'text', text: message }],
      source: { kind: 'plugin', form: 'notice' },
      id: randomUUID(),
      turn,
    } as never
    // Replace the previous injected summary in place (single visible block);
    // fall back to append if the old node was shadowed (e.g. by compaction).
    const previous = findPreviousTaskSummarySeq(agent)
    if (previous !== undefined) {
      try {
        agent.session.append('user/message', data, {
          surfaceOp: { op: 'replace', start: previous, end: previous },
          sourceEventSeqs: [previous],
        } as never)
        lastSummaryTurn.set(agent, turn)
        return
      } catch (err) {
        if (debug) {
          console.error(`[minimal-context] TaskSummary replace failed (${String(err)}); appending`)
        }
      }
    }
    agent.session.append('user/message', data, { surfaceOp: 'append' } as never)
    lastSummaryTurn.set(agent, turn)
  }
  ctx.on('agent/pre-step', async ({ agent, turn, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision
    observeUsage(agent)
    // Low-frequency date anchor: inject [@MM-DD HH:MM] when the calendar day
    // changed since last injection (projection-layer day-change detector).
    injectDateAnchor(agent)
    const result = runFunnel(agent, turn, {
      config,
      compactionAvailable: compactionAvailable(ctx),
    })
    const didCompact =
      result.pointerized > 0 ||
      result.pruned > 0 ||
      result.compacted > 0 ||
      result.summarized === true
    maybeInjectTaskSummary(
      agent,
      turn,
      result.budgetPressure === true,
      didCompact,
      config.taskSummaryInterval ?? 12,
    )
    if (debug) {
      const { nodes, chars } = surfaceTextChars(agent)
      console.error(
        `[minimal-context] turn=${turn} model=${result.model} ctxLimit=${result.contextLimit} ` +
          `budgetChars=${result.effectiveBudgetChars} budgetPressure=${result.budgetPressure} ` +
          `ptrSurface=${result.surfaceCharsAfterPointerize}/${result.surfaceNodesAfterPointerize} ` +
          `pointerized=${result.pointerized} pruned=${result.pruned} compacted=${result.compacted} ` +
          `summarizedFlag=${result.summarized} surfaceNodes=${nodes} surfaceChars=${chars}`,
      )
    }
    return decision
  }, { prepend: true })
}
