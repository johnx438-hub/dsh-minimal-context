/**
 * Plugin-local pointer-card vocabulary and funnel knobs.
 * Structured log-only records. The model-visible stand-in is the replaced
 * `tool/result` body (card text, pruned body, or compacted card).
 *
 * @module @deepseek-ai/dsh-minimal-funnel/types
 */

/** Payload of one `funnel/pointer-card` SessionEvent. */
export interface FunnelPointerCardData {
  /** Source tool-result turn. */
  turn: number
  /** Tool name from the matching `tool/call`. */
  tool: string
  /** sha256 hex of the tool-result text. */
  fingerprint: string
  /** Recall handle (Harness `callId` this cut). */
  action_id: string
  /** Original tool call id (same string as `action_id` this cut). */
  callId: string
  /** Seq of the source `tool/result` event (the surface node that was replaced). */
  sourceSeq: number
  /** Character count of the source tool-result text. */
  chars: number
}

/**
 * Payload of one `funnel/summary-placeholder` SessionEvent.
 * Honest non-LLM record: not a model-written `compaction/summary`.
 */
export interface FunnelSummaryPlaceholderData {
  /** Turn that crossed the summarize threshold. */
  turn: number
  /** Why this event was appended. */
  reason: 'threshold'
  /** Current surface node count. */
  surfaceNodes: number
  /** Concatenated surface text characters. */
  surfaceChars: number
  /** Configured character threshold. */
  thresholdChars: number
  /** Configured surface-node threshold. */
  thresholdNodes: number
  /**
   * Whether `ctx.compaction` was visible. The seam is not invoked: it
   * requires `ctx.llm.stream()` (see compaction-basic summarizer).
   */
  compactionSeam: 'present-not-invoked' | 'absent'
  /** Explicit non-LLM marker for log readers. */
  note: 'non-LLM placeholder; not a model-written summary'
}

/** Optional runtime knobs. Omitted fields use conservative defaults. */
export interface FunnelConfig {
  /**
   * Default min chars for tools without a dedicated rule (minimal unknown-tool
   * threshold ≈ 400).
   */
  pointerizeMinChars?: number
  /** Tool names that must never be pointerized (e.g. recall_query). */
  pointerizeNeverTools?: string[]
  /** Extra never-pointerize body prefixes (case-insensitive). */
  pointerizeNeverPrefixes?: string[]
  /** Prune only when a prior-turn surface tool/result exceeds this many chars. */
  pruneThresholdChars?: number
  /** Head chars kept when head/tail-pruning a still-full body. */
  pruneHeadChars?: number
  /** Tail chars kept when head/tail-pruning a still-full body. */
  pruneTailChars?: number
  /** Full-ish pointer cards kept per older turn; extras are compacted. */
  maxFullCardsPerTurn?: number
  /**
   * Max card downgrades in one funnel pass.
   * Matches minimal `MAX_POINTER_COMPACT_PER_TURN` (20).
   */
  maxCompactPerStep?: number
  /** Summarize placeholder: surface text chars that must be reached. */
  summarizeMinChars?: number
  /** Summarize placeholder: surface node count that must be reached. */
  summarizeMinNodes?: number
  /**
   * Soft surface budget gate (no LLM). When surface chars/nodes exceed caps
   * after pointerize, prune/compact use tighter knobs.
   */
  surfaceBudgetEnabled?: boolean
  /** Keep the last N turns inline before pointerize (recent-layer protection). */
  keepRecentTurns?: number
  /** Inject a [TaskSummary] background message every N turns (0 disables). */
  taskSummaryInterval?: number
  /**
   * Absolute char soft-cap (also used as min() with model-scaled budget).
   * On 1M models this usually wins; on smaller windows the scaled value wins.
   */
  surfaceBudgetChars?: number
  /** Node soft cap for the model-visible surface (OR with chars). */
  surfaceBudgetNodes?: number
  /**
   * Fraction of model context tokens treated as "surface share" when scaling
   * (default 0.08). Combined with charsPerToken → char budget before min(cap).
   */
  surfaceBudgetContextRatio?: number
  /** Rough chars-per-token for scaling (default 4). */
  surfaceBudgetCharsPerToken?: number
  /** Floor after scaling so tiny windows don't prune everything (default 20_000). */
  surfaceBudgetCharsMin?: number
  /** Aggressive pointerize floor while under budget pressure. */
  budgetPointerizeMinChars?: number
  /** Aggressive prune threshold while under budget pressure. */
  budgetPruneThresholdChars?: number
  budgetPruneHeadChars?: number
  budgetPruneTailChars?: number
  budgetMaxFullCardsPerTurn?: number
  budgetMaxCompactPerStep?: number
}

/** Resolved knobs after defaults. */
export interface ResolvedFunnelConfig {
  pointerizeMinChars: number
  pointerizeNeverTools: string[]
  pointerizeNeverPrefixes: string[]
  pruneThresholdChars: number
  pruneHeadChars: number
  pruneTailChars: number
  maxFullCardsPerTurn: number
  maxCompactPerStep: number
  summarizeMinChars: number
  summarizeMinNodes: number
  surfaceBudgetEnabled: boolean
  keepRecentTurns: number
  surfaceBudgetChars: number
  surfaceBudgetNodes: number
  surfaceBudgetContextRatio: number
  surfaceBudgetCharsPerToken: number
  surfaceBudgetCharsMin: number
  budgetPointerizeMinChars: number
  budgetPruneThresholdChars: number
  budgetPruneHeadChars: number
  budgetPruneTailChars: number
  budgetMaxFullCardsPerTurn: number
  budgetMaxCompactPerStep: number
}

/**
 * Conservative defaults.
 * Pointerize floors align with minimal `shouldPointerize` / POINTER_RULES.
 * Prune numbers match `dsh-compaction-tool-result-pruner` DEFAULTS.
 * Compact cap matches minimal `MAX_POINTER_COMPACT_PER_TURN`.
 * Summarize thresholds are high so the stage does not fire every step.
 * Surface budget: soft gate ~100k chars / 80 nodes → tighter prune/compact.
 */
export const FUNNEL_DEFAULTS: ResolvedFunnelConfig = {
  pointerizeMinChars: 400,
  pointerizeNeverTools: ['skill', 'recall_query'],
  pointerizeNeverPrefixes: [],
  pruneThresholdChars: 8192,
  pruneHeadChars: 4096,
  pruneTailChars: 1024,
  maxFullCardsPerTurn: 3,
  maxCompactPerStep: 20,
  summarizeMinChars: 80_000,
  summarizeMinNodes: 64,
  surfaceBudgetEnabled: true,
  keepRecentTurns: 2,
  surfaceBudgetChars: 100_000,
  surfaceBudgetNodes: 80,
  surfaceBudgetContextRatio: 0.08,
  surfaceBudgetCharsPerToken: 4,
  surfaceBudgetCharsMin: 20_000,
  budgetPointerizeMinChars: 300,
  budgetPruneThresholdChars: 4096,
  budgetPruneHeadChars: 2048,
  budgetPruneTailChars: 512,
  budgetMaxFullCardsPerTurn: 1,
  budgetMaxCompactPerStep: 40,
}

/** Fill omitted knobs with {@link FUNNEL_DEFAULTS}. */
export function resolveFunnelConfig(config: FunnelConfig = {}): ResolvedFunnelConfig {
  return {
    pointerizeMinChars:
      config.pointerizeMinChars ?? FUNNEL_DEFAULTS.pointerizeMinChars,
    pointerizeNeverTools:
      config.pointerizeNeverTools ?? [...FUNNEL_DEFAULTS.pointerizeNeverTools],
    pointerizeNeverPrefixes:
      config.pointerizeNeverPrefixes ?? [
        ...FUNNEL_DEFAULTS.pointerizeNeverPrefixes,
      ],
    pruneThresholdChars: config.pruneThresholdChars ?? FUNNEL_DEFAULTS.pruneThresholdChars,
    pruneHeadChars: config.pruneHeadChars ?? FUNNEL_DEFAULTS.pruneHeadChars,
    pruneTailChars: config.pruneTailChars ?? FUNNEL_DEFAULTS.pruneTailChars,
    maxFullCardsPerTurn: config.maxFullCardsPerTurn ?? FUNNEL_DEFAULTS.maxFullCardsPerTurn,
    maxCompactPerStep: config.maxCompactPerStep ?? FUNNEL_DEFAULTS.maxCompactPerStep,
    summarizeMinChars: config.summarizeMinChars ?? FUNNEL_DEFAULTS.summarizeMinChars,
    summarizeMinNodes: config.summarizeMinNodes ?? FUNNEL_DEFAULTS.summarizeMinNodes,
    surfaceBudgetEnabled:
      config.surfaceBudgetEnabled ?? FUNNEL_DEFAULTS.surfaceBudgetEnabled,
    keepRecentTurns:
      config.keepRecentTurns ?? FUNNEL_DEFAULTS.keepRecentTurns,
    surfaceBudgetChars:
      config.surfaceBudgetChars ?? FUNNEL_DEFAULTS.surfaceBudgetChars,
    surfaceBudgetNodes:
      config.surfaceBudgetNodes ?? FUNNEL_DEFAULTS.surfaceBudgetNodes,
    surfaceBudgetContextRatio:
      config.surfaceBudgetContextRatio ?? FUNNEL_DEFAULTS.surfaceBudgetContextRatio,
    surfaceBudgetCharsPerToken:
      config.surfaceBudgetCharsPerToken ?? FUNNEL_DEFAULTS.surfaceBudgetCharsPerToken,
    surfaceBudgetCharsMin:
      config.surfaceBudgetCharsMin ?? FUNNEL_DEFAULTS.surfaceBudgetCharsMin,
    budgetPointerizeMinChars:
      config.budgetPointerizeMinChars ?? FUNNEL_DEFAULTS.budgetPointerizeMinChars,
    budgetPruneThresholdChars:
      config.budgetPruneThresholdChars ?? FUNNEL_DEFAULTS.budgetPruneThresholdChars,
    budgetPruneHeadChars:
      config.budgetPruneHeadChars ?? FUNNEL_DEFAULTS.budgetPruneHeadChars,
    budgetPruneTailChars:
      config.budgetPruneTailChars ?? FUNNEL_DEFAULTS.budgetPruneTailChars,
    budgetMaxFullCardsPerTurn:
      config.budgetMaxFullCardsPerTurn ?? FUNNEL_DEFAULTS.budgetMaxFullCardsPerTurn,
    budgetMaxCompactPerStep:
      config.budgetMaxCompactPerStep ?? FUNNEL_DEFAULTS.budgetMaxCompactPerStep,
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One pointer card for a prior-turn tool result — log-only, no surfaceOp.
     * The model-visible stand-in is the immediately following
     * `compaction/prune` + `tool/result` replace (card text in content).
     * Required fields: turn, tool+fingerprint summary, action_id recall handle.
     */
    'funnel/pointer-card': FunnelPointerCardData
    /**
     * Threshold-triggered summarize record — log-only, no surfaceOp.
     * Not a `compaction/summary` and not model-authored.
     */
    'funnel/summary-placeholder': FunnelSummaryPlaceholderData
  }
}
