import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildToolPreview,
  renderCardWithPreview,
  DEFAULT_PREVIEW_POLICY,
} from '../src/preview.ts'

test('grep_search: pattern+path in summary, matched lines previewed', () => {
  const text = 'src/a.ts:1: foo\nsrc/a.ts:2: bar\nsrc/a.ts:3: baz\n'
  const p = buildToolPreview('grep_search', text, {
    pattern: 'foo',
    path: 'src',
  })
  assert.equal(p.summary, 'grep: 3 line(s), pattern="foo", path=src')
  assert.equal(p.preview.length, 3)
  assert.ok(p.preview[0].includes('src/a.ts:1: foo'))
})

test('read_file: strips file_meta, lower+upper hex, optional newline', () => {
  const text = 'line one\nline two\n\n[file_meta hash=ABC123def lines=2]'
  const p = buildToolPreview('read_file', text, { path: 'src/x.ts', offset: 40 })
  assert.equal(p.summary, 'read_file: src/x.ts, 2 lines, offset=40')
  assert.deepEqual(p.preview, ['line one', 'line two'])
})

test('read_file: file_meta glued to body without leading newline', () => {
  const text = 'body line\n[file_meta hash=abc123 lines=1]'
  const p = buildToolPreview('read_file', text, { path: 'x' })
  assert.equal(p.summary, 'read_file: x, 1 lines')
})

test('run_shell: b64 wins but falls back to plain on bad b64', () => {
  // valid b64 wins
  const a = buildToolPreview('run_shell', 'out\n', {
    command: 'plain-cmd',
    command_b64: Buffer.from('b64-cmd').toString('base64'),
    exitCode: 0,
  })
  assert.ok(a.summary.includes('b64-cmd'), `got: ${a.summary}`)
  // broken b64 falls back to plain
  const b = buildToolPreview('run_shell', 'out\n', {
    command: 'plain-cmd',
    command_b64: '!!!not-base64!!!',
    exitCode: 1,
  })
  assert.ok(b.summary.includes('plain-cmd'), `got: ${b.summary}`)
  assert.ok(b.summary.includes('exit=1'), `got: ${b.summary}`)
})

test('run_shell: URL-safe base64 is normalized before decode', () => {
  const urlSafe = Buffer.from('a+b/c==')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
  const p = buildToolPreview('run_shell', 'out\n', { command_b64: urlSafe })
  assert.ok(p.summary.includes('a+b/c=='), `got: ${p.summary}`)
})

test('mcp__: JSON body gets JSON-aware head, not bare {', () => {
  const json = JSON.stringify({ title: '窗口', items: 3, ok: true })
  const p = buildToolPreview('mcp__cu-perceive__perceive_window', json, {})
  assert.ok(p.summary.includes('head="窗口"'), `got: ${p.summary}`)
  assert.ok(
    p.summary.startsWith('mcp mcp__cu-perceive__perceive_window: 1 line(s)'),
  )
})

test('mcp__: JSON without title falls back to first keys', () => {
  const json = '{"rows":3,"cols":2,"map":"..."}'
  const p = buildToolPreview('mcp__foo__bar', json, {})
  assert.ok(p.summary.includes('rows, cols, map'), `got: ${p.summary}`)
})

test('mcp_ single underscore prefix is NOT treated as MCP tool', () => {
  const p = buildToolPreview('mcp_legacy_tool', 'plain text line\n', {})
  assert.ok(p.summary.startsWith('excerpt'), `got: ${p.summary}`)
})

test('generic: head/tail excerpt with omitted marker', () => {
  const text = 'x'.repeat(2000)
  const p = buildToolPreview('some_tool', text, {})
  assert.ok(p.summary.includes('2000 chars'))
  assert.ok(p.summary.includes('omitted'))
  assert.ok(p.preview.some((l) => l.includes('omitted]…')))
})

test('generic: empty-ish body still yields summary', () => {
  const p = buildToolPreview('some_tool', '', {})
  assert.ok(p.summary.startsWith('excerpt'))
})

test('renderCardWithPreview appends summary and preview lines', () => {
  const card = renderCardWithPreview(
    ['[action:call_1] turn=3', 'tool=grep_search chars=60 sha256=abc'],
    { summary: 'grep: 2 line(s), pattern="x"', preview: ['a:1', 'b:2'] },
  )
  const lines = card.split('\n')
  assert.equal(lines[2], 'summary=grep: 2 line(s), pattern="x"')
  assert.equal(lines[3], 'preview:')
  assert.deepEqual(lines.slice(4), ['a:1', 'b:2'])
})

test('null command arg never throws', () => {
  const p = buildToolPreview('run_shell', 'out\n', {
    command: null as unknown as string,
    command_b64: undefined,
  })
  assert.ok(p.summary.includes('?'), `got: ${p.summary}`)
})

test('emoji at truncation boundary does not crash', () => {
  const emoji = '😀'.repeat(10)
  const p = buildToolPreview('mcp__emoji__test', emoji, {})
  assert.equal(typeof p.summary, 'string')
  assert.ok(p.summary.length > 0)
})

test('preview policy knobs respected', () => {
  const policy = { ...DEFAULT_PREVIEW_POLICY, previewMaxLines: 2 }
  const p = buildToolPreview('grep_search', 'a\nb\nc\nd\n', { pattern: 'x' }, policy)
  assert.equal(p.preview.length, 2)
})
