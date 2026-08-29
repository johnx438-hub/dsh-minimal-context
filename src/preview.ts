/**
 * Smart tool-result previews for pointer cards (port of minimal-agent-ts
 * `src/action-preview.ts`, with fixes for known edge cases).
 *
 * Pure rules only — no LLM, no state, no ctx. Deterministic summaries and
 * head/tail excerpts that ride inside the pointer card so the model can
 * decide whether to recall without paying a cold-store round trip.
 *
 * Port fixes over the original:
 *  - b64 decode failure now falls back to the plain field instead of erroring.
 *  - file-meta hash regex accepts upper-case hex and optional leading newline.
 *  - URL-safe base64 (`-`/`_`) is normalized before decode.
 *  - MCP tools are matched by the DSH `mcp__` prefix (not minimal `mcp_`).
 *  - JSON tool results get a JSON-aware head (title/name/type/status field,
 *    else first keys), never a bare `head="{"`.
 *
 * @module @deepseek-ai/dsh-minimal-funnel/preview
 */

const FILE_META_RE = /\n?\s*\[file_meta hash=([a-fA-F0-9]+) lines=(\d+)\]\s*$/
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/

export interface PreviewPolicy {
  /** Max chars for the one-line `summary=` value. */
  summaryMaxChars: number
  /** Max chars of excerpt text used for `preview:` lines. */
  previewMaxChars: number
  /** Preview body used when the tool has no smart rule. */
  previewRatio: number
  /** Max `preview:` lines emitted. */
  previewMaxLines: number
  /** `smart` dispatches per-tool; `generic` is head/tail only. */
  previewMode: 'smart' | 'generic'
}

export const DEFAULT_PREVIEW_POLICY: PreviewPolicy = {
  summaryMaxChars: 120,
  previewMaxChars: 480,
  previewRatio: 0.04,
  previewMaxLines: 5,
  previewMode: 'smart',
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function truncateLine(line: string, maxLen: number): string {
  const one = line.replace(/\s+/g, ' ').trim()
  if (one.length <= maxLen) return one
  return `${one.slice(0, maxLen)}…`
}

function nonEmptyLines(text: string, maxLines: number): string[] {
  const lines: string[] = []
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue
    lines.push(line.trim())
    if (lines.length >= maxLines) break
  }
  return lines
}

function parseArgsJson(argsJson: string | undefined): Record<string, unknown> {
  if (argsJson === undefined || argsJson === null) return {}
  try {
    const parsed = JSON.parse(argsJson)
    // JSON.parse('null') returns null without throwing — guard it.
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

function normalizeB64(text: string): string {
  return text.replace(/-/g, '+').replace(/_/g, '/')
}

function decodeBase64Utf8(raw: string): string | null {
  const trimmed = raw.replace(/\s+/g, '')
  const normalized = normalizeB64(trimmed)
  if (!B64_RE.test(normalized)) return null
  try {
    const bytes = Buffer.from(normalized, 'base64')
    return bytes.toString('utf8')
  } catch {
    return null
  }
}

/** b64 wins when present (minimal semantics); plain only on b64 failure. */
function decodePlainOrB64(
  args: Record<string, unknown>,
  plainKey: string,
  b64Key: string,
): string | undefined {
  const b64 = args[b64Key]
  if (typeof b64 === 'string' && b64.trim().length > 0) {
    const decoded = decodeBase64Utf8(b64)
    if (decoded !== null) return decoded
  }
  const plain = args[plainKey]
  if (typeof plain === 'string' && plain.length > 0) return plain
  return undefined
}

/** Strip trailing read_file `[file_meta ...]` block if present. */
function stripFileMeta(text: string): string {
  return text.replace(FILE_META_RE, '')
}

function isMcpTool(toolName: string): boolean {
  return toolName.startsWith('mcp__')
}

/** JSON-aware head: title/name/type/status field, else first keys. */
function extractJsonTitle(text: string): string | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined
  try {
    const parsed = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const obj = parsed as Record<string, unknown>
    for (const key of ['title', 'name', 'type', 'status', 'head', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.length > 0) return truncateLine(v, 80)
      if (typeof v === 'number') return `${key}=${v}`
    }
    const keys = Object.keys(obj)
    if (keys.length > 0) return truncateLine(keys.slice(0, 3).join(', '), 80)
  } catch {
    /* not JSON after all — caller falls back to generic head */
  }
  return undefined
}

function countLines(text: string): number {
  return text.split('\n').length
}

/* ------------------------------------------------------------------ */
/* smart per-tool previews                                             */
/* ------------------------------------------------------------------ */

function grepPreview(
  text: string,
  args: Record<string, unknown>,
  policy: PreviewPolicy,
): { summary: string; preview: string[] } {
  const pattern = typeof args.pattern === 'string' ? args.pattern : '?'
  const path = typeof args.path === 'string' ? args.path : undefined
  const lineCount = nonEmptyLines(text, Number.MAX_SAFE_INTEGER).length
  const summary = `grep: ${lineCount} line(s), pattern="${truncateLine(pattern, 60)}"${
    path ? `, path=${path}` : ''
  }`
  const preview = nonEmptyLines(text, policy.previewMaxLines).map((l) =>
    truncateLine(l, 100),
  )
  return { summary, preview }
}

function readPreview(
  text: string,
  args: Record<string, unknown>,
  policy: PreviewPolicy,
): { summary: string; preview: string[] } {
  const path = typeof args.path === 'string' ? args.path : undefined
  const offset = typeof args.offset === 'number' ? args.offset : undefined
  const body = stripFileMeta(text)
  const lines = countLines(body)
  const summary = `read_file: ${path ?? '?'}, ${lines} lines${
    offset !== undefined ? `, offset=${offset}` : ''
  }`
  const preview = nonEmptyLines(body, policy.previewMaxLines).map((l) =>
    truncateLine(l, 100),
  )
  return { summary, preview }
}

function shellPreview(
  text: string,
  args: Record<string, unknown>,
  policy: PreviewPolicy,
): { summary: string; preview: string[] } {
  const command = decodePlainOrB64(args, 'command', 'command_b64')
  const exitCode = typeof args.exitCode === 'number' ? args.exitCode : undefined
  const exitLabel =
    exitCode === 0 ? 'ok' : exitCode === undefined ? '' : `exit=${exitCode}`
  const summary = `shell: ${truncateLine(command ?? '?', 60)}${
    exitLabel ? ` (${exitLabel})` : ''
  }`
  const preview = nonEmptyLines(text, policy.previewMaxLines).map((l) =>
    truncateLine(l, 100),
  )
  return { summary, preview }
}

function editPreview(
  text: string,
  args: Record<string, unknown>,
  policy: PreviewPolicy,
): { summary: string; preview: string[] } {
  const path = typeof args.path === 'string' ? args.path : undefined
  const summary = `edit_file: ${path ?? '?'} (search_replace)`
  const preview = nonEmptyLines(text, policy.previewMaxLines).map((l) =>
    truncateLine(l, 100),
  )
  return { summary, preview }
}

function mcpPreview(
  text: string,
  toolName: string,
  policy: PreviewPolicy,
): { summary: string; preview: string[] } {
  const lineCount = countLines(text)
  const jsonTitle = extractJsonTitle(text)
  const head = jsonTitle ?? truncateLine(nonEmptyLines(text, 1)[0] ?? '', 80)
  const summary = `mcp ${toolName}: ${lineCount} line(s), head="${head}"`
  const preview = nonEmptyLines(text, policy.previewMaxLines).map((l) =>
    truncateLine(l, 100),
  )
  return { summary, preview }
}

/* ------------------------------------------------------------------ */
/* generic head/tail excerpt                                            */
/* ------------------------------------------------------------------ */

function genericPreview(
  text: string,
  policy: PreviewPolicy,
): { summary: string; preview: string[] } {
  const total = text.length
  const headBudget = Math.max(1, Math.floor(policy.previewMaxChars * 0.65))
  const tailBudget = Math.max(1, policy.previewMaxChars - headBudget)
  const head = text.slice(0, headBudget)
  const omitted = total - headBudget - tailBudget
  const tail = omitted > 0 ? text.slice(total - tailBudget) : ''
  const summary = `excerpt head+tail (${total} chars${
    omitted > 0 ? `, ~${omitted} omitted` : ''
  })`
  const preview = [
    ...nonEmptyLines(head, Math.max(1, policy.previewMaxLines - 1)),
    ...(omitted > 0
      ? [`…[${omitted} chars omitted]…`]
      : []),
    ...(tail ? nonEmptyLines(tail, 1) : []),
  ]
  return { summary, preview }
}

/* ------------------------------------------------------------------ */
/* public entry                                                         */
/* ------------------------------------------------------------------ */

export interface ToolPreview {
  summary: string
  preview: string[]
}

/** Build a deterministic preview for one tool-result body. */
export function buildToolPreview(
  toolName: string,
  text: string,
  args: Record<string, unknown>,
  policy: PreviewPolicy = DEFAULT_PREVIEW_POLICY,
): ToolPreview {
  if (policy.previewMode === 'generic') return genericPreview(text, policy)

  if (isMcpTool(toolName)) return mcpPreview(text, toolName, policy)
  switch (toolName) {
    case 'grep_search':
      return grepPreview(text, args, policy)
    case 'read_file':
      return readPreview(text, args, policy)
    case 'run_shell':
      return shellPreview(text, args, policy)
    case 'edit_file':
      return editPreview(text, args, policy)
    default:
      return genericPreview(text, policy)
  }
}

/** Render the model-facing card text with preview lines appended. */
export function renderCardWithPreview(
  cardLines: string[],
  preview: ToolPreview,
): string {
  const summaryLine = `summary=${preview.summary}`
  const previewLines = preview.preview.length > 0
    ? ['preview:', ...preview.preview]
    : []
  return [...cardLines, summaryLine, ...previewLines].join('\n')
}
