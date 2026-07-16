/**
 * Strict-but-forgiving JSON intake for MODEL-PRODUCED text (owner escalation
 * 2026-07-16: "agent ke JSON pare? strictly + guard soho").
 *
 * Models wrap JSON in prose, code fences, smart quotes and trailing commas.
 * Every internal consumer (completion gate, signal scan, structured briefs)
 * previously hand-rolled its own tolerant parse — some tolerant, some not.
 * This is the ONE guarded door:
 *
 *   parseModelJson(text, validate?) →
 *     { ok: true, value } | { ok: false, error }
 *
 * Guarantees: never throws, never eval-like tricks, size-capped, and when a
 * `validate` guard is given the value ONLY comes back if the guard accepts it
 * — a shape mismatch is a parse failure, not a downstream surprise.
 */

const MAX_JSON_CHARS = 200_000

/** Strip markdown code fences and surrounding prose; return candidate slices. */
function candidateSlices(raw: string): string[] {
  const text = raw.slice(0, MAX_JSON_CHARS)
  const out: string[] = []
  // 1) fenced blocks first — models love ```json … ```
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m[1].trim()) out.push(m[1].trim())
  }
  // 2) the whole text as-is
  out.push(text.trim())
  // 3) first balanced {...} or [...] block
  for (const open of ['{', '[']) {
    const close = open === '{' ? '}' : ']'
    const start = text.indexOf(open)
    if (start === -1) continue
    let depth = 0
    let inStr = false
    let esc = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === open) depth++
      else if (c === close) {
        depth--
        if (depth === 0) {
          out.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  return out
}

/** Conservative repairs that cannot change valid JSON: smart quotes, trailing commas. */
function repair(candidate: string): string {
  return candidate
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
}

export type ParsedJson<T> = { ok: true; value: T } | { ok: false; error: string }

/**
 * Parse JSON out of model text. `validate` is the guard: return true to
 * accept, false to reject (rejection = failure, never a half-typed value).
 */
export function parseModelJson<T = unknown>(
  raw: string | null | undefined,
  validate?: (v: unknown) => v is T,
): ParsedJson<T> {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: 'empty_input' }
  let lastError = 'no_json_found'
  for (const slice of candidateSlices(raw)) {
    for (const attempt of [slice, repair(slice)]) {
      try {
        const value = JSON.parse(attempt) as unknown
        if (validate && !validate(value)) {
          lastError = 'shape_rejected'
          continue
        }
        return { ok: true, value: value as T }
      } catch (err) {
        lastError = err instanceof Error ? err.message.slice(0, 120) : 'parse_failed'
      }
    }
  }
  return { ok: false, error: lastError }
}

/** Convenience guard builders for the common shapes. */
export function isObjectWith<K extends string>(...keys: K[]): (v: unknown) => v is Record<K, unknown> {
  return (v: unknown): v is Record<K, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && keys.every((k) => k in (v as object))
}

export function isArrayOf<T>(item: (v: unknown) => v is T): (v: unknown) => v is T[] {
  return (v: unknown): v is T[] => Array.isArray(v) && v.every(item)
}
