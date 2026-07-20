/**
 * G10 / SPEC-097 — Large result summarization WITHOUT an LLM.
 *
 * Deterministically shrinks a large tool result to a compact, structure-preserving
 * summary using pure rules — NO model call (INV-01, the whole point of this spec):
 *   - arrays keep the first N items + an omitted count (and a tiny numeric digest
 *     when the array is all numbers),
 *   - strings are truncated to a char cap with their original length noted,
 *   - objects keep their keys but their values are summarized, bounded by depth.
 * The result is smaller and lossy-but-honest (every truncation is marked), so a
 * model can reason over the shape without the raw blob.
 */
import {
  type ComponentResult,
  completed,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'

export const SUMMARIZE_CONTRACT_VERSION = '1.0.0' as const

export interface SummarizeOptions {
  maxItems: number
  maxStringChars: number
  maxDepth: number
  maxKeys: number
}
export const DEFAULT_SUMMARIZE: SummarizeOptions = { maxItems: 5, maxStringChars: 200, maxDepth: 4, maxKeys: 40 }

export interface SummarizeMeta {
  truncatedArrays: number
  truncatedStrings: number
  truncatedObjects: number
  depthClipped: number
}

function numericDigest(nums: number[]): { count: number; min: number; max: number; sum: number } {
  let min = Infinity
  let max = -Infinity
  let sum = 0
  for (const n of nums) {
    if (n < min) min = n
    if (n > max) max = n
    sum += n
  }
  return { count: nums.length, min, max, sum }
}

function walk(value: unknown, depth: number, opts: SummarizeOptions, meta: SummarizeMeta): unknown {
  if (depth > opts.maxDepth) {
    meta.depthClipped += 1
    return '[clipped: max depth]'
  }
  if (typeof value === 'string') {
    if (value.length > opts.maxStringChars) {
      meta.truncatedStrings += 1
      return { _str: value.slice(0, opts.maxStringChars) + '…', _len: value.length }
    }
    return value
  }
  if (Array.isArray(value)) {
    const head = value.slice(0, opts.maxItems).map((v) => walk(v, depth + 1, opts, meta))
    const out: Record<string, unknown> = { _items: head }
    if (value.length > opts.maxItems) {
      meta.truncatedArrays += 1
      out._omitted = value.length - opts.maxItems
      out._total = value.length
    }
    if (value.length > 0 && value.every((v) => typeof v === 'number')) {
      out._digest = numericDigest(value as number[])
    }
    return out
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    const kept = entries.slice(0, opts.maxKeys)
    const out: Record<string, unknown> = {}
    for (const [k, v] of kept) out[k] = walk(v, depth + 1, opts, meta)
    if (entries.length > opts.maxKeys) {
      meta.truncatedObjects += 1
      out._omittedKeys = entries.length - opts.maxKeys
    }
    return out
  }
  return value // number | boolean | null | undefined
}

export interface SummarizeResult {
  summary: unknown
  meta: SummarizeMeta
}

export function summarize(value: unknown, options: Partial<SummarizeOptions> = {}): SummarizeResult {
  // Coalesce per-field so an explicit `undefined` never clobbers a default.
  const opts: SummarizeOptions = {
    maxItems: options.maxItems ?? DEFAULT_SUMMARIZE.maxItems,
    maxStringChars: options.maxStringChars ?? DEFAULT_SUMMARIZE.maxStringChars,
    maxDepth: options.maxDepth ?? DEFAULT_SUMMARIZE.maxDepth,
    maxKeys: options.maxKeys ?? DEFAULT_SUMMARIZE.maxKeys,
  }
  const meta: SummarizeMeta = { truncatedArrays: 0, truncatedStrings: 0, truncatedObjects: 0, depthClipped: 0 }
  const summary = walk(value, 0, opts, meta)
  return { summary, meta }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const summarizeRequestSchema = z.object({
  payload: z.unknown(),
  maxItems: z.number().int().positive().max(100).optional(),
  maxStringChars: z.number().int().positive().max(4000).optional(),
  maxDepth: z.number().int().positive().max(12).optional(),
  maxKeys: z.number().int().positive().max(200).optional(),
})

export function summarizeResult(raw: unknown): ComponentResult<SummarizeResult> {
  const check = validateRequest(raw, summarizeRequestSchema, SUMMARIZE_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const p = check.request.payload
  const result = summarize(p.payload, { maxItems: p.maxItems, maxStringChars: p.maxStringChars, maxDepth: p.maxDepth, maxKeys: p.maxKeys })
  return completed(result, [], { summarize: SUMMARIZE_CONTRACT_VERSION })
}
