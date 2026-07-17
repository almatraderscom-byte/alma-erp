/**
 * P8 (behaviour-parity) — best-effort salvage of a tool-call arguments string
 * that failed JSON.parse.
 *
 * Why: on a JSON.parse failure the adapter falls back to the single-key
 * `{ _raw }` marker, which tool-contract.ts already converts into a retryable
 * self-repair error. That works, but it burns a whole extra model round even
 * when the args were trivially fixable (markdown fences, trailing commas, single
 * quotes, a truncated brace) — exactly the mistakes weaker heads (Grok/DeepSeek)
 * make far more than frontier models. We try cheap deterministic fixes (no LLM)
 * FIRST so a recoverable call just succeeds; only genuinely broken args fall
 * through to the existing `{ _raw }` self-repair path.
 *
 * Only activates ON a parse failure, so it never changes a well-formed call.
 */
import { AGENT_TOOLCALL_REPAIR } from '@/agent/config'

export type ToolArgRepairResult =
  | { ok: true; value: Record<string, unknown>; repaired: boolean }
  | { ok: false; error: string; raw: string }

export function repairToolArgs(raw: string | null | undefined): ToolArgRepairResult {
  const original = raw ?? ''
  // Empty / whitespace args mean "no arguments" → {} (matches the old
  // `JSON.parse(buf.args || '{}')` behaviour).
  if (!original.trim()) return { ok: true, value: {}, repaired: false }

  const direct = tryParseObject(original)
  if (direct) return { ok: true, value: direct, repaired: false }

  if (!AGENT_TOOLCALL_REPAIR) {
    return { ok: false, error: 'unparseable tool arguments', raw: original }
  }

  let s = original.trim()
  // Strip markdown code fences: ```json ... ```
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  // If there is leading/trailing prose, keep the outermost object span.
  const span = s.match(/\{[\s\S]*\}/)
  if (span) s = span[0]

  const noTrailing = stripTrailingCommas(s)
  const candidates = [
    s,
    noTrailing,
    balanceBraces(noTrailing),
    singleToDoubleQuotes(noTrailing),
    balanceBraces(singleToDoubleQuotes(noTrailing)),
  ]
  for (const c of candidates) {
    const parsed = tryParseObject(c)
    if (parsed) return { ok: true, value: parsed, repaired: true }
  }
  return { ok: false, error: 'unparseable tool arguments after repair', raw: original }
}

function tryParseObject(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Remove commas that sit right before a closing } or ]. */
function stripTrailingCommas(s: string): string {
  return s.replace(/,(\s*[}\]])/g, '$1')
}

/** Last-resort: convert single-quoted delimiters to double quotes. Only ever
 * used if the result actually parses, so a stray apostrophe that breaks JSON
 * simply falls through to the next candidate. */
function singleToDoubleQuotes(s: string): string {
  return s.replace(/'/g, '"')
}

/** Append missing closing braces when the model truncated its own JSON. */
function balanceBraces(s: string): string {
  let depth = 0
  for (const ch of s) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
  }
  return depth > 0 ? s + '}'.repeat(depth) : s
}
