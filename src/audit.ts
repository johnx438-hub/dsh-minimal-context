/**
 * L1 audit block — render DSH's already-computed file diffs into model-visible
 * text. DSH edit/write tools attach contextual diff hunks to `tool/result`
 * events as opaque `meta.diffs` (see `dsh-tool-fs/src/diff.ts`, persisted with
 * the session log, replayed identically). The model-facing render only prints
 * "Updated file" / "Edited …", so the diff is invisible to the model even
 * though the harness computed and persisted it.
 *
 * This module renders that hidden meta into an audit block:
 *
 *   ok: edited /abs/path (284 bytes) file_hash=<sha256>      ← summary (fact)
 *   [edit_display]                                           ← display (process)
 *   --- a/abs/path (edit)
 *   +++ b/abs/path (edit)
 *   @@ -10,3 +10,4 @@
 *    ...
 *   [/edit_display]
 *
 * Design notes:
 * - We NEVER recompute diffs — the harness already did (performance + identity
 *   with what the UI shows). We only read `event.data.meta` and narrow it with
 *   the same defensive checks the harness uses (`diffsFromMeta` spirit).
 * - Detection is meta-driven: presence of validated `meta.diffs` IS the signal
 *   that a file mutation happened — no tool-name lookup needed.
 * - The summary line stays in context (fact layer, never pointerized — the
 *   `ok: edited` prefix already matches `NEVER_PREFIXES`). The display block is
 *   wrapped in `[edit_display]` markers so a later L2 stage can pointerize just
 *   the display region while keeping the summary inline.
 * - Malformed or absent meta yields `null` — never throw on replay of an older
 *   session whose tool schema differs.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/audit
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { freezeMessage } from '@deepseek-ai/dsh-llm'
import type { ToolResultMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { eventAt, allEvents } from './session-events.ts'
import { codePointLength, toolResultText } from './surface.ts'

/** Marker wrapping the diff display region (L2 pointerize target). */
export const EDIT_DISPLAY_START = '\n[edit_display]\n'
export const EDIT_DISPLAY_END = '\n[/edit_display]\n'

interface FileDiff {
  path: string
  oldText: string | null
  newText: string
}

/**
 * Defensive narrowing of the opaque `meta.diffs` payload, mirroring
 * `dsh-tool-fs/src/diff.ts` `isFileDiff` so malformed replayed meta never throws.
 */
function isFileDiff(value: unknown): value is FileDiff {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { path, oldText, newText } = value as Record<string, unknown>
  return typeof path === 'string'
    && (oldText === null || typeof oldText === 'string')
    && typeof newText === 'string'
}

/** Narrow opaque event meta to validated non-empty diffs, or undefined. */
export function diffsFromMeta(meta: unknown): FileDiff[] | undefined {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const diffs = (meta as Record<string, unknown>).diffs
  if (!Array.isArray(diffs) || diffs.length === 0 || !diffs.every(isFileDiff)) return undefined
  return diffs
}

/** Render one hunk as a unified-style display (oldText → newText). */
function renderHunk(diff: FileDiff): string {
  const oldLines = diff.oldText === null ? [] : diff.oldText.split('\n')
  const newLines = diff.newText.split('\n')
  const lines: string[] = []
  for (const l of oldLines) lines.push(`- ${l}`)
  for (const l of newLines) lines.push(`+ ${l}`)
  return lines.join('\n')
}

/**
 * Build the audit block for a `tool/result` event, or `null` when there is
 * nothing to audit (no validated meta.diffs).
 *
 * The summary line is "ok: <tool> <path> (<bytes> bytes) result_hash=<hash>" so
 * the existing `NEVER_PREFIXES` inline protection keeps it in context. The
 * display region is wrapped in `[edit_display]` markers for L2.
 */
export function renderDiffAudit(event: SessionEvent<'tool/result'>): string | null {
  const diffs = diffsFromMeta(event.data.meta)
  if (diffs === undefined) return null

  const body = toolResultText(event)
  const path = diffs[0]?.path ?? '(unknown)'
  // result_hash hashes the audit/result body text — an anchor for the tool
  // RESULT, NOT the file content on disk. For a real content/version anchor
  // (concurrent-edit detection) a separate content_hash of the after-text is
  // needed; do not use result_hash as if it were the file's hash.
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 12)
  const bytes = codePointLength(body)

  const hunks = diffs.map(renderHunk).join('\n')
  const display = `${EDIT_DISPLAY_START}--- a/${path}\n+++ b/${path}\n${hunks}${EDIT_DISPLAY_END}`

  return `ok: edited ${path} (${bytes} bytes) result_hash=${hash}${display}`
}

/** Split an audit block into summary (fact) and display (process) parts. */
export function splitAuditBlock(audit: string): { summary: string; display: string } {
  const start = audit.indexOf(EDIT_DISPLAY_START)
  if (start < 0) return { summary: audit, display: '' }
  const summary = audit.slice(0, start).trimEnd()
  const display = audit.slice(start)
  return { summary, display }
}

/** True when an audit block's display region is present (L2 pointerize cue). */
export function hasAuditDisplay(audit: string): boolean {
  return audit.includes(EDIT_DISPLAY_START) && audit.includes(EDIT_DISPLAY_END)
}

/**
 * Inject audit blocks into prior-turn `tool/result` events that carry
 * `meta.diffs`. Runs before pointerize.
 *
 * The injected block **replaces** the model-facing body (the harness render is
 * only "Updated file" / "Edited …" — no audit value), so the new body starts
 * with `ok: edited` and hits `NEVER_PREFIXES`, keeping summary + display
 * inline (L1) and giving L2 a stable `[edit_display]` region to pointerize.
 * Idempotent — an event already carrying an `[edit_display]` block is skipped.
 *
 * @returns number of events annotated.
 */
export function injectAuditBlocks(agent: Agent, currentTurn: number): number {
  let count = 0
  for (const seq of [...agent.session.surface.nodes]) {
    const event = eventAt(agent, seq)
    if (event?.type !== 'tool/result') continue
    // NOTE: intentionally NOT filtered by turn. DSH long turns (agent drives
    // many steps autonomously) would otherwise delay audit injection until a
    // real turn boundary, making the audit block useless mid-workflow. The
    // idempotency guards (audited/compacted/summary-only) make re-injection
    // impossible, so injecting current-turn results is safe.
    if (diffsFromMeta(event.data.meta) === undefined) continue

    const block = event.data.message.content[0]
    if (block === undefined || block.type !== 'tool-result') continue
    const texts = block.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    const joined = texts.map((c) => c.text).join('')
    // Idempotent: skip when already audited (full START+END pair) OR already
    // L2-compacted ([edit_display compacted] — no full pair, but re-injecting
    // would undo the compaction) OR already a summary-only audit line.
    if (
      hasAuditDisplay(joined)
      || joined.includes('[edit_display compacted')
      || /^ok: edited /m.test(joined)
    ) continue

    const audit = renderDiffAudit(event)
    if (audit === null) continue

    // Replace the whole body with the audit block (starts with `ok: edited`),
    // so NEVER_PREFIXES inline protection holds even on real harness renders
    // like "The file updated successfully.".
    const message = freezeMessage<ToolResultMessage>({
      ...event.data.message,
      content: [{
        ...block,
        content: [{ type: 'text', text: audit }],
      }] as [typeof block],
    })
    agent.session.append('tool/result', {
      ...event.data,
      message,
    }, {
      surfaceOp: { op: 'replace', start: seq, end: seq },
      sourceEventSeqs: [seq],
    })
    count += 1
  }
  return count
}
