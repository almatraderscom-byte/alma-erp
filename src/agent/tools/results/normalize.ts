/**
 * G10 / SPEC-098 — Search and browser result normalization.
 *
 * Search/browser tools return wildly different shapes ({results}, {organic},
 * {data}, bare arrays, DOM extracts). This normalizes them to ONE canonical,
 * sanitized, bounded shape so the model always sees the same thing:
 *   { title, url?, snippet }[]
 * Sanitisation is fail-safe: only http(s) urls survive (javascript:/data: are
 * dropped), snippets are trimmed + length-capped, and the item count is bounded.
 *
 * Deterministic, no LLM (INV-01).
 */
import {
  type ComponentResult,
  REASON_CODES,
  completed,
  failure,
  validateRequest,
} from '@/agent/contracts'
import { z } from 'zod'

export const NORMALIZE_CONTRACT_VERSION = '1.0.0' as const

export const MAX_ITEMS = 10
export const MAX_SNIPPET_CHARS = 300
export const MAX_TITLE_CHARS = 200

export interface NormalizedItem {
  title: string
  url?: string
  snippet: string
}
export interface NormalizedResults {
  items: NormalizedItem[]
  total: number
  truncated: boolean
}

const TITLE_KEYS = ['title', 'name', 'heading', 'headline']
const URL_KEYS = ['url', 'link', 'href', 'source_url', 'permalink']
const SNIPPET_KEYS = ['snippet', 'description', 'text', 'content', 'summary', 'body', 'excerpt']

function pick(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  return undefined
}

/** Keep only safe http(s) urls. */
function safeUrl(u: string | undefined): string | undefined {
  if (!u) return undefined
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : undefined
}

function cap(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…'
}

/** Find the array of raw result rows inside a heterogeneous payload. */
function extractRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload
  if (payload && typeof payload === 'object') {
    const o = payload as Record<string, unknown>
    for (const key of ['results', 'organic', 'data', 'items', 'hits', 'entries']) {
      if (Array.isArray(o[key])) return o[key] as unknown[]
    }
  }
  return []
}

function toItem(row: unknown): NormalizedItem | null {
  if (typeof row === 'string') {
    const t = row.trim()
    return t ? { title: cap(t, MAX_TITLE_CHARS), snippet: '' } : null
  }
  if (row && typeof row === 'object') {
    const o = row as Record<string, unknown>
    const title = pick(o, TITLE_KEYS)
    const snippet = pick(o, SNIPPET_KEYS) ?? ''
    const url = safeUrl(pick(o, URL_KEYS))
    if (!title && !url && !snippet) return null
    return {
      title: cap(title ?? url ?? '(untitled)', MAX_TITLE_CHARS),
      ...(url ? { url } : {}),
      snippet: cap(snippet, MAX_SNIPPET_CHARS),
    }
  }
  return null
}

/** Normalize a heterogeneous search/browser payload to canonical items. */
export function normalizeSearchResults(payload: unknown, maxItems = MAX_ITEMS): NormalizedResults {
  const cap2 = Math.max(1, Math.min(Math.floor(maxItems), MAX_ITEMS))
  const rows = extractRows(payload)
  const items = rows.map(toItem).filter((i): i is NormalizedItem => i !== null)
  return { items: items.slice(0, cap2), total: items.length, truncated: items.length > cap2 }
}

// ── Identity-enforced boundary ──────────────────────────────────────────────

const normalizeRequestSchema = z.object({
  payload: z.unknown(),
  maxItems: z.number().int().positive().optional(),
})

export function normalizeResults(raw: unknown): ComponentResult<NormalizedResults> {
  const check = validateRequest(raw, normalizeRequestSchema, NORMALIZE_CONTRACT_VERSION)
  if (!check.ok) return check.failure
  const p = check.request.payload
  const result = normalizeSearchResults(p.payload, p.maxItems ?? MAX_ITEMS)
  if (result.total === 0) return failure('FAILED_FINAL', [REASON_CODES.MALFORMED_INPUT])
  return completed(result, [], { normalize: NORMALIZE_CONTRACT_VERSION })
}
