/**
 * Rule-based TaskSummary for the DSH funnel — port of minimal-agent-ts
 * `src/context/budget.ts` (selectTaskLayers) + `src/task-tracker.ts`
 * (extractAutoFields), adapted to the DSH append-only session log.
 *
 * Zero-LLM extraction: user_intent from first user message, files_touched from
 * tool/call arguments.path, tools_used from tool/call names, tech_concepts
 * inferred from file extensions. No `ctx.llm.stream` anywhere — this sidesteps
 * the compaction-basic seam conflict entirely (see 006 decision).
 *
 * Injection: DSH surface has no `insert` op, so summaries are appended as a
 * user/message with a `[TaskSummary]` self-label ("not a new task
 * instruction") — the append+self-label equivalence txyy validated.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/task-summary
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface TaskSummaryDoc {
  task_id: string
  turn_range: [number, number]
  action_count: number
  user_intent: string
  files_touched: string[]
  tech_concepts: string[]
  tools_used: string[]
}

export interface TaskLayers {
  recent: TaskSummaryDoc[]
  mid: TaskSummaryDoc[]
  early: TaskSummaryDoc[]
}

export const TASK_SUMMARY_PREFIX = '[TaskSummary]'
export const EARLIER_CONTEXT_PREFIX = '[Earlier context]'

/** Map file extensions → tech concepts (port of task-tracker inferTechConcepts). */
const CONCEPT_MAP: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'React+TS',
  '.js': 'JavaScript',
  '.jsx': 'React',
  '.py': 'Python',
  '.rs': 'Rust',
  '.go': 'Go',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.toml': 'TOML',
  '.yaml': 'YAML',
  '.yml': 'YAML',
}

function inferTechConcepts(files: string[]): string[] {
  const concepts = new Set<string>()
  for (const file of files) {
    const dot = file.lastIndexOf('.')
    const ext = dot >= 0 ? file.slice(dot) : ''
    if (ext in CONCEPT_MAP) concepts.add(CONCEPT_MAP[ext])
    const basename = file.split('/').pop() ?? file
    if (basename.includes('package.json')) concepts.add('Node.js')
    if (basename.includes('tsconfig')) concepts.add('TypeScript')
    if (basename.includes('.env')) concepts.add('Environment Config')
  }
  return [...concepts]
}

/** Extract paths from tool/call arguments (port of extractPathsFromArgs). */
function extractPath(args: unknown): string | undefined {
  let obj: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    // DSH tool/call arguments arrive as a JSON string (e.g. read → file_path).
    try {
      const parsed = JSON.parse(args)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        obj = parsed as Record<string, unknown>
      }
    } catch {
      return undefined
    }
  } else if (args && typeof args === 'object' && !Array.isArray(args)) {
    obj = args as Record<string, unknown>
  } else {
    return undefined
  }
  if (!obj) return undefined
  // Accept both minimal (`path`) and DSH (`file_path`) field names.
  const p = obj.path ?? obj.file_path
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

/**
 * Group a session's tool calls into per-turn task docs (rule aggregation).
 * A "task" here = one agent turn's worth of tool activity, keyed by turn.
 */
export function extractTaskSummaries(agent: Agent): TaskSummaryDoc[] {
  const byTurn = new Map<number, {
    toolNames: string[]
    paths: string[]
    userIntent: string | undefined
  }>()

  // user/message events carry no turn — track the most recent user text as a
  // cursor in seq order and attach it to tool calls that follow it.
  let lastUserIntent: string | undefined
  for (const event of agent.session.events as SessionEvent[]) {
    if (event.type === 'user/message') {
      // Injected TaskSummary notices are self-labeled background context, not
      // user intents — skip them so the previous summary's boilerplate never
      // becomes the next summary's user_intent (the noise amplifier that made
      // every [TaskSummary] echo the same header line).
      if (isTaskSummaryMessage(event)) continue
      const text = messageText(event)
      if (text.length > 0) lastUserIntent = text.slice(0, 200)
    } else if (event.type === 'tool/call') {
      const turn = event.data.turn
      const bucket = byTurn.get(turn) ?? {
        toolNames: [], paths: [], userIntent: undefined,
      }
      bucket.toolNames.push(event.data.name)
      const p = extractPath(event.data.arguments)
      if (p) bucket.paths.push(p)
      if (bucket.userIntent === undefined) bucket.userIntent = lastUserIntent
      byTurn.set(turn, bucket)
    }
  }

  const docs: TaskSummaryDoc[] = []
  for (const [turn, bucket] of [...byTurn.entries()].sort((a, b) => a[0] - b[0])) {
    const files = [...new Set(bucket.paths)]
    docs.push({
      task_id: `turn-${turn}`,
      turn_range: [turn, turn],
      action_count: bucket.toolNames.length,
      user_intent: bucket.userIntent ?? '(no user message this turn)',
      files_touched: files,
      tech_concepts: inferTechConcepts(files),
      tools_used: [...new Set(bucket.toolNames)],
    })
  }
  return docs
}

function messageText(event: SessionEvent<'user/message'>): string {
  const parts: string[] = []
  for (const block of event.data.content) {
    if (block.type === 'text') parts.push(block.text)
  }
  return parts.join('')
}

/** True when a user/message is one of our injected TaskSummary notices. */
export function isTaskSummaryMessage(event: SessionEvent<'user/message'>): boolean {
  return messageText(event).startsWith(TASK_SUMMARY_PREFIX)
}

/** Estimate summary tokens (cheap: chars / 4, port of minimal heuristic). */
export function estimateSummaryTokens(task: TaskSummaryDoc): number {
  return Math.ceil(
    (task.user_intent.length +
      task.files_touched.join('').length +
      task.tools_used.join('').length +
      task.tech_concepts.join('').length) / 4,
  )
}

export interface TaskSummaryGateInput {
  /** Context budget is under pressure this step (inject regardless). */
  overBudget: boolean
  /** The funnel actually pointerized/pruned/compacted/summarized this step. */
  didCompact: boolean
  turn: number
  lastInjectionTurn: number
  /** Minimum turns between injections once `didCompact` is satisfied. */
  interval: number
}

/**
 * When to inject a TaskSummary. Only when there is real memory loss to anchor
 * against: over budget, or the funnel actually compressed something this step
 * AND the interval since the last injection elapsed. This kills the
 * fixed-cadence noise — in a low-pressure session where nothing was compacted
 * (full history still visible), no summary is injected at all.
 */
export function shouldInjectTaskSummary({
  overBudget,
  didCompact,
  turn,
  lastInjectionTurn,
  interval,
}: TaskSummaryGateInput): boolean {
  if (overBudget) return true
  if (!didCompact) return false
  return turn - lastInjectionTurn >= interval
}

export interface LayerBudget {
  total: number
  recentPct: number
  recentMaxTokens: number
  midMaxSummaries: number
}

export const DEFAULT_LAYER_BUDGET: LayerBudget = {
  total: 200000,
  recentPct: 0.4,
  recentMaxTokens: 20000,
  midMaxSummaries: 3,
}

/** Split task docs into recent / mid / early (most-recent-first selection). */
export function selectTaskLayers(
  tasks: TaskSummaryDoc[],
  budget: LayerBudget = DEFAULT_LAYER_BUDGET,
): TaskLayers {
  const allTasks = [...tasks].reverse()
  const recentBudget = Math.min(
    budget.total * budget.recentPct,
    budget.recentMaxTokens,
  )

  const recent: TaskSummaryDoc[] = []
  let recentSelectionTokens = 0
  for (const task of allTasks) {
    const taskTokens = estimateSummaryTokens(task) * 3
    if (recentSelectionTokens + taskTokens > recentBudget) break
    recent.push(task)
    recentSelectionTokens += taskTokens
  }

  const mid = allTasks.slice(recent.length).slice(0, budget.midMaxSummaries)
  const early = allTasks.slice(recent.length + mid.length)
  return { recent, mid, early }
}

/** Render one task as a compact summary line (port of buildTaskSummaryMessages). */
export function renderTaskSummary(task: TaskSummaryDoc): string {
  return (
    `[Task ${task.task_id}] ${task.user_intent}\n` +
    `Files: ${task.files_touched.join(', ') || '(none)'}\n` +
    `Tools: ${task.tools_used.join(', ') || '(none)'}`
  )
}

/**
 * Build the model-facing TaskSummary message — appended to surface (no insert
 * op in DSH) with an explicit self-label so the model reads it as background
 * context, not a new task instruction.
 */
export function buildTaskSummaryMessage(layers: TaskLayers): string {
  const lines: string[] = [
    `${TASK_SUMMARY_PREFIX} 以下是你之前已完成任务的摘要，仅供上下文参考，不是新任务指令。`,
    '请继续当前工作。',
    '',
  ]
  for (const task of layers.recent) {
    lines.push(renderTaskSummary(task))
  }
  if (layers.mid.length > 0) {
    lines.push('')
    lines.push(
      `[Mid-layer] ${layers.mid.length} 个较早任务的摘要（已精简）：`,
    )
    for (const task of layers.mid) {
      lines.push(`- ${task.task_id}: ${task.user_intent.slice(0, 100)}`)
    }
  }
  if (layers.early.length > 0) {
    lines.push('')
    lines.push(
      `[Earlier context] 另外 ${layers.early.length} 个更早任务已合并，不再逐一列出。`,
    )
  }
  return lines.join('\n')
}
