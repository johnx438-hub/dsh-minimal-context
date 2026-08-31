import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  EDIT_DISPLAY_END,
  EDIT_DISPLAY_START,
  diffsFromMeta,
  hasAuditDisplay,
  injectAuditBlocks,
  renderDiffAudit,
  splitAuditBlock,
} from '../src/audit.ts'

/** Minimal tool/result event shaped like dsh-tool-fs write/edit output. */
function makeToolResult(opts: {
  turn: number
  meta?: unknown
  body?: string
  callId?: string
}): { event: any; seq: number } {
  const callId = opts.callId ?? 'call_1'
  return {
    seq: opts.turn,
    event: {
      type: 'tool/result',
      seq: opts.turn,
      data: {
        turn: opts.turn,
        step: 1,
        message: {
          source: { kind: 'tool', callId },
          content: [{
            type: 'tool-result',
            toolCallId: callId,
            content: [{ type: 'text', text: opts.body ?? 'ok: edited /tmp/x (5 bytes)' }],
          }],
        },
        ...(opts.meta !== undefined ? { meta: opts.meta } : {}),
      },
    },
  }
}

describe('audit diffsFromMeta', () => {
  it('accepts valid diffs', () => {
    const diffs = diffsFromMeta({
      diffs: [{ path: '/a', oldText: 'x', newText: 'y' }],
    })
    assert.equal(diffs?.length, 1)
    assert.equal(diffs![0].path, '/a')
  })

  it('rejects malformed meta (non-array, empty, bad fields)', () => {
    assert.equal(diffsFromMeta(null), undefined)
    assert.equal(diffsFromMeta({}), undefined)
    assert.equal(diffsFromMeta({ diffs: [] }), undefined)
    assert.equal(diffsFromMeta({ diffs: [{ path: 1 }] }), undefined)
    assert.equal(diffsFromMeta({ diffs: [{ path: '/a', oldText: null, newText: null }] }), undefined)
  })

  it('accepts oldText:null (pure insert)', () => {
    const diffs = diffsFromMeta({ diffs: [{ path: '/a', oldText: null, newText: 'new' }] })
    assert.equal(diffs?.length, 1)
  })
})

describe('audit renderDiffAudit', () => {
  it('renders summary + display from meta', () => {
    const { event } = makeToolResult({
      turn: 5,
      meta: { diffs: [{ path: '/tmp/x', oldText: 'a\nb', newText: 'a\nc' }] },
      body: 'ok: edited /tmp/x (5 bytes)',
    })
    const audit = renderDiffAudit(event)
    assert.ok(audit)
    assert.match(audit!, /^ok: edited \/tmp\/x \(\d+ bytes\) result_hash=[0-9a-f]{12}/)
    assert.ok(audit!.includes(EDIT_DISPLAY_START))
    assert.ok(audit!.includes(EDIT_DISPLAY_END))
    assert.ok(audit!.includes('- a'))
    assert.ok(audit!.includes('- b'))
    assert.ok(audit!.includes('+ c'))
  })

  it('returns null when no meta.diffs', () => {
    const { event } = makeToolResult({ turn: 5 })
    assert.equal(renderDiffAudit(event), null)
  })

  it('returns null on malformed meta (never throws)', () => {
    const { event } = makeToolResult({ turn: 5, meta: { diffs: 'oops' } })
    assert.equal(renderDiffAudit(event), null)
  })

  it('handles pure insert (oldText null)', () => {
    const { event } = makeToolResult({
      turn: 6,
      meta: { diffs: [{ path: '/new', oldText: null, newText: 'hello' }] },
    })
    const audit = renderDiffAudit(event)
    assert.ok(audit)
    assert.ok(audit!.includes('+ hello'))
    assert.ok(!audit!.includes('- hello'))
  })
})

describe('audit splitAuditBlock / hasAuditDisplay', () => {
  it('splits summary from display', () => {
    const audit = `ok: edited /a (1 bytes) result_hash=abc${EDIT_DISPLAY_START}--- a//a\n+++ b//a\n- x\n+ y${EDIT_DISPLAY_END}`
    const { summary, display } = splitAuditBlock(audit)
    assert.match(summary, /^ok: edited \/a/)
    assert.ok(display.startsWith(EDIT_DISPLAY_START))
    assert.ok(display.endsWith(EDIT_DISPLAY_END))
  })

  it('hasAuditDisplay detects both markers', () => {
    assert.ok(hasAuditDisplay(`x${EDIT_DISPLAY_START}---\n${EDIT_DISPLAY_END}`))
    assert.ok(!hasAuditDisplay('no markers'))
    assert.ok(!hasAuditDisplay(`only start${EDIT_DISPLAY_START}\n`))
  })
})

describe('audit injectAuditBlocks', () => {
  function makeAgent(events: any[]): any {
    const maxSeq = Math.max(...events.map((e) => e.seq))
    const arr = new Array(maxSeq + 1).fill(undefined)
    for (const e of events) arr[e.seq] = e
    return {
      session: {
        events: arr,
        surface: { nodes: events.map((e) => e.seq) },
        append(_type: string, data: any, opts: any) {
          const at = opts.surfaceOp.start
          this.events[at] = { ...this.events[at], data: { ...data } }
        },
      },
    }
  }

  it('annotates a prior-turn fs tool result with audit block', () => {
    const { event, seq } = makeToolResult({
      turn: 5,
      meta: { diffs: [{ path: '/tmp/x', oldText: 'a', newText: 'b' }] },
      body: 'The file updated successfully.',
    })
    const agent = makeAgent([event])
    const n = injectAuditBlocks(agent, 7)
    assert.equal(n, 1)
    const text = agent.session.events[seq].data.message.content[0].content.map((c: any) => c.text).join('')
    // Body is REPLACED, not appended: starts with ok: edited, no leftover original.
    assert.ok(text.startsWith('ok: edited'))
    assert.ok(!text.includes('The file updated successfully.'))
    assert.ok(text.includes(EDIT_DISPLAY_START))
    assert.ok(text.includes('result_hash='))
  })

  it('real-harness body still keeps summary inline (NEVER_PREFIXES holds)', async () => {
    // Grok review: with DSH's real render ("The file updated successfully."),
    // after injection the body must start with `ok: edited` so shouldPointerize
    // returns false — summary stays in context, not folded into a card.
    const { event, seq } = makeToolResult({
      turn: 5,
      meta: { diffs: [{ path: '/tmp/x', oldText: 'a', newText: 'b' }] },
      body: 'The file updated successfully.',
    })
    const agent = makeAgent([event])
    injectAuditBlocks(agent, 7)
    const text = agent.session.events[seq].data.message.content[0].content.map((c: any) => c.text).join('')
    assert.ok(text.startsWith('ok: edited'))
    const { shouldPointerize } = await import('../src/eligibility.ts')
    const { resolveFunnelConfig } = await import('../src/types.ts')
    assert.equal(shouldPointerize('edit', text, resolveFunnelConfig()), false)
  })

  it('skips current-turn results (not yet auditable)', () => {
    const { event } = makeToolResult({
      turn: 7,
      meta: { diffs: [{ path: '/tmp/x', oldText: 'a', newText: 'b' }] },
    })
    const agent = makeAgent([event])
    assert.equal(injectAuditBlocks(agent, 7), 0)
  })

  it('is idempotent (skips already-annotated events)', () => {
    const { event, seq } = makeToolResult({
      turn: 5,
      meta: { diffs: [{ path: '/tmp/x', oldText: 'a', newText: 'b' }] },
      body: `ok: edited /tmp/x (5 bytes)${EDIT_DISPLAY_START}---\n[/edit_display]`,
    })
    const agent = makeAgent([event])
    assert.equal(injectAuditBlocks(agent, 7), 0) // already carries marker
    void seq
  })

  it('skips events without meta.diffs', () => {
    const { event } = makeToolResult({ turn: 5 })
    const agent = makeAgent([event])
    assert.equal(injectAuditBlocks(agent, 7), 0)
  })
})
