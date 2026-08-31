import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderDiffAudit, splitAuditBlock, hasAuditDisplay, EDIT_DISPLAY_START, EDIT_DISPLAY_END } from '../src/audit.ts'
import { pointerize } from '../src/pointerize.ts'
import { resolveFunnelConfig } from '../src/types.ts'

/** Build an audit-bearing tool/result event with a display of given size. */
function makeAuditEvent(opts: { turn: number; displayChars?: number; metaDiffs?: boolean }): { event: any; seq: number } {
  const callId = 'call_audit1'
  const pad = 'x'.repeat(Math.max(0, (opts.displayChars ?? 100) - 10))
  const body = `ok: edited /tmp/big.txt (${5000 + pad.length} bytes) result_hash=abc123${EDIT_DISPLAY_START}--- a//tmp/big.txt\n+++ b//tmp/big.txt\n- old\n+ new\n${pad}${EDIT_DISPLAY_END}`
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
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: body }] }],
        },
        ...(opts.metaDiffs === false
          ? {}
          : { meta: { diffs: [{ path: '/tmp/big.txt', oldText: 'old\nline', newText: 'new\nline' }] } }),
      },
    },
  }
}

function makeAgent(events: any[]): any {
  // Compact array (real DSH session.events has no holes); surface.nodes are
  // indexes into it. Tool/call events must precede their tool/result.
  const arr = [...events]
  return {
    session: {
      events: arr,
      surface: {
        nodes: arr
          .map((e, i) => (e?.type === 'tool/result' ? i : -1))
          .filter((i) => i >= 0),
      },
      append(_type: string, data: any, opts: any) {
        const at = opts.surfaceOp.start
        this.events[at] = { ...this.events[at], data: { ...data } }
      },
    },
    options: {},
  }
}

describe('L2 audit display pointerize', () => {
  it('compacts a large [edit_display] display but keeps summary inline', () => {
    const { event, seq } = makeAuditEvent({ turn: 3, displayChars: 2000 })
    const toolCall = { type: 'tool/call', seq: seq - 1, data: { callId: 'call_audit1', name: 'edit', arguments: {} } }
    const agent = makeAgent([toolCall, event])
    const n = pointerize(agent, 5, resolveFunnelConfig({ displayPointerizeMinChars: 600 }))
    assert.equal(n, 1)
    const text = agent.session.events[1]?.data?.message?.content?.[0]?.content?.map((c: any) => c.text).join('') ?? ''
    // summary kept
    assert.ok(text.includes('ok: edited /tmp/big.txt'))
    assert.ok(text.includes('result_hash=abc123'))
    // display replaced by compacted line
    assert.ok(text.includes('[edit_display compacted:'))
    assert.ok(!text.includes('x'.repeat(50))) // padding gone
    assert.ok(!hasAuditDisplay(text)) // no full START+END pair anymore
  })

  it('keeps small display fully inline', () => {
    const { event } = makeAuditEvent({ turn: 3, displayChars: 100 })
    const toolCall = { type: 'tool/call', seq: 2, data: { callId: 'call_audit1', name: 'edit', arguments: {} } }
    const agent = makeAgent([toolCall, event])
    const n = pointerize(agent, 5, resolveFunnelConfig({ displayPointerizeMinChars: 600 }))
    assert.equal(n, 0)
    const text = agent.session.events[1]?.data?.message?.content?.[0]?.content?.map((c: any) => c.text).join('') ?? ''
    assert.ok(hasAuditDisplay(text)) // untouched
  })

  it('splitAuditBlock separates summary and display', () => {
    const audit = `ok: edited /a (1 bytes) result_hash=abc${EDIT_DISPLAY_START}--- a//a\n+++ b//a\n- x\n+ y${EDIT_DISPLAY_END}`
    const { summary, display } = splitAuditBlock(audit)
    assert.match(summary, /^ok: edited \/a/)
    assert.ok(display.startsWith(EDIT_DISPLAY_START))
    assert.ok(display.endsWith(EDIT_DISPLAY_END))
  })

  it('renderDiffAudit reconstructs full diff from meta even after compaction', () => {
    const { event } = makeAuditEvent({ turn: 3, displayChars: 2000 })
    const audit = renderDiffAudit(event)
    assert.ok(audit)
    // hunk is line-wise -/+: oldText lines as '-', newText lines as '+'
    assert.ok(audit!.includes('- old'))
    assert.ok(audit!.includes('- line'))
    assert.ok(audit!.includes('+ new'))
    assert.ok(audit!.includes('+ line'))
    assert.ok(audit!.includes('result_hash='))
  })
})
