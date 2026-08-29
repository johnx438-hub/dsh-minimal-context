/**
 * context_focus — main-agent temporary pointerize keep boost.
 *
 * Port of minimal-agent-ts `src/tools/context-focus.ts` onto the DSH funnel.
 * The agent can say "keep these tools inline for the next N turns" so large
 * tool results stay visible instead of becoming pointer cards immediately —
 * useful for multi-clause review / large-file cross-check where recall_query
 * round-trips would be wasteful.
 *
 * Design notes (port differences vs minimal):
 *  - State lives in a WeakMap keyed by Agent (session-scoped, auto-collected),
 *    not on `config.pointerizeFocus`. The funnel's `pointerize()` reads it via
 *    `getFocusState(agent)`.
 *  - `isFocusProtected(toolName, state)` is a pure predicate: a prior-turn
 *    tool result is skipped by pointerize while a matching focus is active.
 *    No keep-window arithmetic needed — DSH surface is binary (inline or
 *    card), so focus only *suppresses* pointerization.
 *  - High-pressure escape hatch: `shouldForcePointerize()` mirrors minimal's
 *    soft_force_ratio by consulting the budget gate (see eligibility.ts).
 *
 * @module @deepseek-ai/dsh-minimal-funnel/context-focus
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const CONTEXT_FOCUS_TOOL = 'context_focus'

export const CONTEXT_FOCUS_KEEP_DEFAULT = 12
export const CONTEXT_FOCUS_KEEP_MAX = 20
export const CONTEXT_FOCUS_TTL_DEFAULT = 8
export const CONTEXT_FOCUS_TTL_MAX = 30

/** Active focus state (per agent, session-scoped). */
export interface PointerizeFocusState {
  /** Raised inline window (turns) for matched tools. */
  keepInlineTurns: number
  /** Turns remaining before automatic expiry. */
  remainingTurns: number
  /** Optional tool whitelist; empty/undefined = all tools. */
  tools: string[] | undefined
  /** Optional short reason, logged in the tool result. */
  reason: string | undefined
}

/** WeakMap state store: dies with the agent, no config pollution. */
const focusStates = new WeakMap<Agent, PointerizeFocusState>()

export function getFocusState(agent: Agent): PointerizeFocusState | undefined {
  return focusStates.get(agent)
}

export function setFocusState(agent: Agent, state: PointerizeFocusState): void {
  focusStates.set(agent, state)
}

export function clearFocusState(agent: Agent): void {
  focusStates.delete(agent)
}

/** Decrement TTL once per turn-end; returns true when expired (caller deletes). */
export function tickFocusState(agent: Agent): boolean {
  const state = focusStates.get(agent)
  if (!state) return false
  state.remainingTurns -= 1
  if (state.remainingTurns <= 0) {
    focusStates.delete(agent)
    return true
  }
  return false
}

/**
 * Pure predicate: should a prior-turn tool result of `toolName` be kept inline
 * (i.e. NOT pointerized) because of an active focus?
 *
 * Mirrors minimal `resolveKeepWithFocus`: focus matches when the whitelist is
 * empty or contains the tool. DSH surface is binary, so a match simply
 * suppresses pointerization for the whole focus window.
 */
export function isFocusProtected(
  toolName: string,
  state: PointerizeFocusState | undefined,
): boolean {
  if (!state) return false
  if (state.remainingTurns <= 0) return false
  if (state.tools && state.tools.length > 0 && !state.tools.includes(toolName)) {
    return false
  }
  return true
}

/**
 * High-pressure escape hatch: even an active focus must not defeat pointerize
 * when the surface is over budget. Mirrors minimal `shouldForcePointerize`
 * (soft_force_ratio). The funnel passes its current budget verdict in.
 */
export function shouldForcePointerize(overBudget: boolean): boolean {
  return overBudget
}

const DESCRIPTION =
  'Temporarily raise how long tool results stay inline before pointer cards ' +
  '(for multi-clause review / large-file cross-check). Main agent only. ' +
  'Does not disable compression under high context pressure. ' +
  'Use clear=true to cancel early. Prefer over busy recall loops.'

/** Register `context_focus` on `ctx.tools` when the registry is composed. */
export function registerContextFocus(ctx: {
  inject: (deps: string[], cb: (toolsCtx: {
    tools: { register: (t: ReturnType<typeof defineTool>) => void }
  }) => void) => void
}): void {
  ctx.inject(['tools'], (toolsCtx) => {
    toolsCtx.tools.register(defineTool({
      name: CONTEXT_FOCUS_TOOL,
      description: DESCRIPTION,
      parameters: {
        keep_inline_turns: {
          type: 'integer',
          description: `Raised keep window (default ${CONTEXT_FOCUS_KEEP_DEFAULT}, max ${CONTEXT_FOCUS_KEEP_MAX}).`,
        },
        ttl_turns: {
          type: 'integer',
          description: `How many agent turns the boost lasts (default ${CONTEXT_FOCUS_TTL_DEFAULT}, max ${CONTEXT_FOCUS_TTL_MAX}).`,
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tool names that get the raised keep (default: all tools).',
        },
        reason: {
          type: 'string',
          description: 'Short reason for logs (e.g. multi-clause code review).',
        },
        clear: {
          type: 'boolean',
          description: 'If true, cancel any active context_focus.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      execute(args, exec) {
        if (!exec.agent) {
          throw new Error('context_focus requires an owning agent session')
        }
        const agent = exec.agent
        const result = runContextFocusTool(agent, args)
        return Promise.resolve(result)
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'Context focus',
        kind: 'edit',
        rawInput: typeof args.reason === 'string' ? args.reason : 'context_focus',
      }),
    }))
  })
}

/** Pure logic behind the tool (testable without a harness). */
export function runContextFocusTool(
  agent: Agent,
  args: Record<string, unknown>,
): string {
  if (args.clear === true) {
    clearFocusState(agent)
    return 'ok: context_focus cleared; pointerize keep window restored to policy defaults'
  }

  const keepRaw = args.keep_inline_turns
  const keep =
    keepRaw === undefined
      ? CONTEXT_FOCUS_KEEP_DEFAULT
      : Math.min(
          CONTEXT_FOCUS_KEEP_MAX,
          Math.max(0, Math.floor(Number(keepRaw))),
        )
  if (!Number.isFinite(keep)) {
    return `error: keep_inline_turns must be a number 0..${CONTEXT_FOCUS_KEEP_MAX}`
  }

  const ttlRaw = args.ttl_turns
  const ttl =
    ttlRaw === undefined
      ? CONTEXT_FOCUS_TTL_DEFAULT
      : Math.min(
          CONTEXT_FOCUS_TTL_MAX,
          Math.max(1, Math.floor(Number(ttlRaw))),
        )
  if (!Number.isFinite(ttl)) {
    return `error: ttl_turns must be a number 1..${CONTEXT_FOCUS_TTL_MAX}`
  }

  let tools: string[] | undefined
  if (Array.isArray(args.tools)) {
    tools = args.tools
      .map((t) => String(t).trim())
      .filter(Boolean)
    if (tools.length === 0) tools = undefined
  }

  const reason =
    typeof args.reason === 'string' && args.reason.trim()
      ? args.reason.trim().slice(0, 200)
      : undefined

  setFocusState(agent, {
    keepInlineTurns: keep,
    remainingTurns: ttl,
    tools,
    reason,
  })

  const toolNote = tools?.length
    ? ` tools=[${tools.join(', ')}]`
    : ' tools=all'
  const reasonNote = reason ? ` reason=${JSON.stringify(reason)}` : ''
  return (
    `ok: context_focus active keep_inline_turns=${keep} ttl_turns=${ttl}` +
    `${toolNote}${reasonNote}. ` +
    'Large tool bodies stay inline longer; high context still forces cards.'
  )
}
