/**
 * Pointerize eligibility — aligned with minimal `shouldPointerize` / POINTER_RULES,
 * adapted for DSH tool names (bash, etc.).
 *
 * @module @deepseek-ai/dsh-minimal-funnel/eligibility
 */

import type { ResolvedFunnelConfig } from './types.ts'

/** Per-tool char / line thresholds (minimal POINTER_RULES spirit). */
export const TOOL_RULES: Record<
  string,
  { minChars: number; alwaysIfLines?: number }
> = {
  bash: { minChars: 800, alwaysIfLines: 30 },
  shell: { minChars: 800, alwaysIfLines: 30 },
  run_terminal_command: { minChars: 800, alwaysIfLines: 30 },
  read_file: { minChars: 600, alwaysIfLines: 40 },
  grep: { minChars: 500, alwaysIfLines: 20 },
  web_fetch: { minChars: 800, alwaysIfLines: 40 },
  web_search: { minChars: 600, alwaysIfLines: 25 },
  // NOTE: inline protection (write/edit/skill/recall_query results never
  // pointerize — passive permanent context_focus) is fully CONFIG-DRIVEN:
  // see pointerizeNeverTools in types.ts. TOOL_RULES only holds ordinary
  // char/line thresholds, so users can extend/trim the protection list.
}

/** Prefixes that must stay inline (errors / short oks). */
export const NEVER_PREFIXES = ['error:', 'ok: wrote', 'ok: edited'] as const

/**
 * Whether a prior-turn tool result body should become a pointer card.
 *
 * Inline protection (passive permanent context_focus): any tool listed in
 * `config.pointerizeNeverTools` (defaults: write/edit/write_file/edit_file/
 * apply_patch/skill/recall_query) NEVER pointerizes — results stay in
 * context. Fully config-driven; extend the list to protect more tools.
 */
export function shouldPointerize(
  toolName: string,
  raw: string,
  config: ResolvedFunnelConfig,
): boolean {
  const name = toolName.trim() || 'unknown'
  if (config.pointerizeNeverTools.some((t) => t === name || name.endsWith(`/${t}`))) {
    return false
  }

  const trimmed = raw.trim()
  if (!trimmed) return false

  for (const p of config.pointerizeNeverPrefixes) {
    if (trimmed.toLowerCase().startsWith(p.toLowerCase())) return false
  }
  for (const p of NEVER_PREFIXES) {
    if (trimmed.toLowerCase().startsWith(p)) return false
  }

  const rule = TOOL_RULES[name] ?? { minChars: config.pointerizeMinChars }
  if (rule.alwaysIfLines) {
    const lines = trimmed.split('\n').length
    if (lines >= rule.alwaysIfLines) return true
  }
  return trimmed.length >= rule.minChars
}
