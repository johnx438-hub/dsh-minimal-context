import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractTaskSummaries,
  selectTaskLayers,
  buildTaskSummaryMessage,
  renderTaskSummary,
  estimateSummaryTokens,
  isTaskSummaryMessage,
  shouldInjectTaskSummary,
  TASK_SUMMARY_PREFIX,
  DEFAULT_LAYER_BUDGET,
  type TaskSummaryDoc,
} from '../src/task-summary.ts'

/** Build a minimal fake Agent with a session.events array. */
function fakeAgent(events: unknown[]): { session: { events: unknown[] } } {
  return { session: { events } } as never
}

function toolCall(turn: number, name: string, path?: string): unknown {
  return {
    type: 'tool/call',
    data: { turn, name, arguments: path ? { path } : {} },
  }
}

function userMsg(turn: number, text: string): unknown {
  return {
    type: 'user/message',
    data: {
      turn,
      content: [{ type: 'text', text }],
    },
  }
}

test('extractTaskSummaries: zero-LLM rule aggregation', () => {
  const agent = fakeAgent([
    userMsg(1, '请重构 budget.ts 并加测试'),
    toolCall(1, 'read_file', 'src/budget.ts'),
    toolCall(1, 'edit_file', 'src/budget.ts'),
    toolCall(2, 'grep_search', 'src/'),
    userMsg(2, '检查一下 calibrator'),
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.equal(docs.length, 2)
  const t1 = docs[0]
  assert.equal(t1.task_id, 'turn-1')
  assert.equal(t1.user_intent, '请重构 budget.ts 并加测试')
  assert.deepEqual(t1.files_touched, ['src/budget.ts'])
  assert.deepEqual(t1.tools_used, ['read_file', 'edit_file'])
  assert.ok(t1.tech_concepts.includes('TypeScript')) // .ts → TypeScript
  assert.equal(t1.action_count, 2)
})

test('extractTaskSummaries: dedup files and tools, path-less calls ok', () => {
  const agent = fakeAgent([
    toolCall(1, 'run_shell'), // no path
    toolCall(1, 'read_file', 'a.ts'),
    toolCall(1, 'read_file', 'a.ts'), // dup
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.deepEqual(docs[0].files_touched, ['a.ts'])
  assert.deepEqual(docs[0].tools_used, ['run_shell', 'read_file'])
})

test('extractTaskSummaries: tech_concepts from filenames', () => {
  const agent = fakeAgent([
    toolCall(1, 'read_file', 'package.json'),
    toolCall(1, 'read_file', 'tsconfig.json'),
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.ok(docs[0].tech_concepts.includes('Node.js'))
  assert.ok(docs[0].tech_concepts.includes('TypeScript'))
})

test('selectTaskLayers: recent/mid/early split', () => {
  const tasks: TaskSummaryDoc[] = []
  for (let i = 0; i < 10; i++) {
    tasks.push({
      task_id: `turn-${i}`,
      turn_range: [i, i],
      action_count: 1,
      user_intent: `task ${i}`,
      files_touched: [],
      tech_concepts: [],
      tools_used: [],
    })
  }
  // tiny recent budget so only ~2 tasks fit in recent; mid takes next 3
  const layers = selectTaskLayers(tasks, {
    ...DEFAULT_LAYER_BUDGET,
    total: 20, // recent budget = 20*0.4 = 8 → ~1-2 tasks
    recentMaxTokens: 8,
    midMaxSummaries: 3,
  })
  assert.ok(layers.recent.length >= 1, 'recent non-empty')
  assert.equal(layers.recent.length + layers.mid.length + layers.early.length, 10)
  assert.equal(layers.mid.length, 3)
  assert.ok(layers.early.length > 0)
})

test('buildTaskSummaryMessage: self-label prefix and layer markers', () => {
  const layers = {
    recent: [{
      task_id: 'turn-1',
      turn_range: [1, 1] as [number, number],
      action_count: 2,
      user_intent: '重构 budget',
      files_touched: ['src/budget.ts'],
      tech_concepts: ['TypeScript'],
      tools_used: ['read_file'],
    }],
    mid: [{
      task_id: 'turn-0',
      turn_range: [0, 0] as [number, number],
      action_count: 1,
      user_intent: '旧任务',
      files_touched: [],
      tech_concepts: [],
      tools_used: [],
    }],
    early: [],
  }
  const msg = buildTaskSummaryMessage(layers)
  assert.ok(msg.startsWith(TASK_SUMMARY_PREFIX))
  assert.ok(msg.includes('不是新任务指令'))
  assert.ok(msg.includes('[Mid-layer]'))
  assert.ok(msg.includes('重构 budget'))
})

test('buildTaskSummaryMessage: early context line', () => {
  const layers = {
    recent: [] as TaskSummaryDoc[],
    mid: [] as TaskSummaryDoc[],
    early: [{ task_id: 't', turn_range: [0, 0] as [number, number], action_count: 1, user_intent: 'x', files_touched: [], tech_concepts: [], tools_used: [] }],
  }
  const msg = buildTaskSummaryMessage(layers)
  assert.ok(msg.includes('另外 1 个更早任务已合并'))
})

test('renderTaskSummary: includes files and tools', () => {
  const t: TaskSummaryDoc = {
    task_id: 'turn-3',
    turn_range: [3, 3],
    action_count: 1,
    user_intent: '加测试',
    files_touched: ['a.test.ts'],
    tech_concepts: ['TypeScript'],
    tools_used: ['write_file'],
  }
  const s = renderTaskSummary(t)
  assert.ok(s.includes('[Task turn-3] 加测试'))
  assert.ok(s.includes('Files: a.test.ts'))
  assert.ok(s.includes('Tools: write_file'))
})

test('estimateSummaryTokens: cheap heuristic', () => {
  const t: TaskSummaryDoc = {
    task_id: 't', turn_range: [0, 0], action_count: 1,
    user_intent: 'a'.repeat(40), files_touched: [], tech_concepts: [], tools_used: [],
  }
  assert.equal(estimateSummaryTokens(t), 10)
})

test('extractTaskSummaries: DSH arguments as JSON string with file_path', () => {
  const agent = fakeAgent([
    userMsg(1, '读 README'),
    // DSH tool/call: arguments is a JSON STRING, field is file_path
    { type: 'tool/call', data: { turn: 1, name: 'read', arguments: '{"file_path": "/repo/README.md"}' } },
    { type: 'tool/call', data: { turn: 1, name: 'write_file', arguments: '{"file_path": "/repo/new.ts"}' } },
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.deepEqual(docs[0].files_touched, ['/repo/README.md', '/repo/new.ts'])
  assert.ok(docs[0].tech_concepts.includes('TypeScript')) // new.ts → TS
})

test('extractTaskSummaries: mixed object args (minimal) and JSON string (DSH)', () => {
  const agent = fakeAgent([
    userMsg(1, '混合参数'),
    { type: 'tool/call', data: { turn: 1, name: 'read_file', arguments: { path: 'src/a.ts' } } }, // minimal shape
    { type: 'tool/call', data: { turn: 1, name: 'read', arguments: '{"file_path": "src/b.ts"}' } }, // DSH shape
    { type: 'tool/call', data: { turn: 1, name: 'run_shell', arguments: null } }, // no args
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.deepEqual(docs[0].files_touched, ['src/a.ts', 'src/b.ts'])
})

test('extractTaskSummaries: broken JSON string ignored', () => {
  const agent = fakeAgent([
    userMsg(1, '坏 JSON'),
    { type: 'tool/call', data: { turn: 1, name: 'read', arguments: '{not json' } },
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.deepEqual(docs[0].files_touched, [])
})

test('isTaskSummaryMessage: detects self-labeled injected notices', () => {
  const notice = userMsg(1, `${TASK_SUMMARY_PREFIX} 以下是你之前已完成任务的摘要，仅供上下文参考，不是新任务指令。`)
  const real = userMsg(1, '帮我改一下 budget.ts')
  assert.equal(isTaskSummaryMessage(notice as never), true)
  assert.equal(isTaskSummaryMessage(real as never), false)
})

test('extractTaskSummaries: injected TaskSummary is not a user intent (self-pollution fix)', () => {
  const agent = fakeAgent([
    userMsg(1, '请重构 budget.ts'), // real user intent
    toolCall(1, 'read_file', 'src/budget.ts'),
    // an injected TaskSummary notice (self-labeled) before the next turn's tools
    userMsg(2, `${TASK_SUMMARY_PREFIX} 以下是你之前已完成任务的摘要，仅供上下文参考，不是新任务指令。\n请继续当前工作。`),
    toolCall(2, 'edit_file', 'src/budget.ts'),
  ])
  const docs = extractTaskSummaries(agent as never)
  assert.equal(docs.length, 2)
  assert.equal(docs[0].user_intent, '请重构 budget.ts')
  // turn-2 must NOT inherit the summary boilerplate as its intent
  assert.equal(docs[1].user_intent, '请重构 budget.ts')
  assert.ok(!docs[1].user_intent.includes('不是新任务指令'))
})

test('shouldInjectTaskSummary: over budget always injects', () => {
  const base = { turn: 5, lastInjectionTurn: 0, interval: 12 }
  assert.equal(shouldInjectTaskSummary({ ...base, overBudget: true, didCompact: false }), true)
  assert.equal(shouldInjectTaskSummary({ ...base, overBudget: true, didCompact: true }), true)
})

test('shouldInjectTaskSummary: no compression → never injects (fixed-cadence noise fix)', () => {
  // interval long elapsed but nothing was compressed → skip
  assert.equal(
    shouldInjectTaskSummary({ overBudget: false, didCompact: false, turn: 100, lastInjectionTurn: 0, interval: 12 }),
    false,
  )
})

test('shouldInjectTaskSummary: compacted + interval elapsed → inject; not elapsed → skip', () => {
  const base = { overBudget: false, didCompact: true }
  assert.equal(shouldInjectTaskSummary({ ...base, turn: 13, lastInjectionTurn: 1, interval: 12 }), true)
  assert.equal(shouldInjectTaskSummary({ ...base, turn: 5, lastInjectionTurn: 1, interval: 12 }), false)
})
