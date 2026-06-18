/**
 * Empty-result awareness (Phase 4 — tool-failure intelligence).
 *
 * Tool results are `{ success, data, error }`. A tool can succeed
 * (`success: true`) yet return nothing useful: `data` is an empty array `[]`
 * or an empty object `{}`. Previously the model saw `{"success":true,"data":[]}`
 * and would sometimes report "✅ পাওয়া গেছে / হয়ে গেছে" — a confident answer
 * built on zero rows.
 *
 * `annotateEmptyResult` wraps such results with an explicit `_empty: true` flag
 * and a human-readable `_note`, so the model unambiguously sees "this lookup
 * returned nothing" and tells the owner that, or refines the query — instead of
 * fabricating a result.
 *
 * Deliberately conservative:
 *  - Only flags top-level empty array / empty object. These are the clear
 *    "I queried and got zero" shapes.
 *  - Does NOT flag `data == null`/`undefined`. Action tools (delete/update/post)
 *    legitimately return `{ success: true }` with no payload; flagging those as
 *    "empty" would wrongly imply the action failed.
 *  - Does NOT touch the verifier or trigger retries — pure annotation, no new
 *    model round-trips, so it cannot increase cost.
 */

type ToolResultLike = { success?: boolean; data?: unknown; error?: string }

/** True only for the unambiguous "queried, got zero rows" shapes. */
export function isEmptyResultData(data: unknown): boolean {
  if (Array.isArray(data)) return data.length === 0
  if (data !== null && typeof data === 'object') {
    return Object.keys(data as Record<string, unknown>).length === 0
  }
  return false
}

const EMPTY_NOTE =
  'EMPTY RESULT — the tool succeeded but returned no data (no matching rows/records). ' +
  'Do NOT claim anything was found, created, or exists based on this. Tell the owner ' +
  'nothing matched, or refine the query / try another tool.'

/**
 * Returns the result unchanged when it has data (same reference), or a shallow
 * clone annotated with `_empty`/`_note` when a successful result is empty.
 * Safe to call on any value; non-object inputs pass through untouched.
 */
export function annotateEmptyResult<T>(result: T): T {
  if (!result || typeof result !== 'object') return result
  const r = result as ToolResultLike
  if (r.success === true && 'data' in r && isEmptyResultData(r.data)) {
    return { ...r, _empty: true, _note: EMPTY_NOTE } as unknown as T
  }
  return result
}
