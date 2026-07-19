/**
 * Phase 63 (was Phase 45) — the ONE canonical place the Meta Graph API version
 * lives. Moved here from `src/agent/lib/marketing/meta-version.ts` so that ERP
 * shared code (`src/lib/*`, `src/app/*`) can use it too: the one-way dependency
 * rule forbids ERP → `src/agent` imports, which is exactly why those files kept
 * hard-coding the version literal (audit GAP-11). This module imports nothing
 * from `src/agent`, so every layer can share it.
 *
 * Every TS call site uses `metaGraphBase()`; worker `.mjs` files mirror the same
 * default in `worker/src/meta-version.mjs` (they cannot import TS). The default
 * stays on the version the codebase was built and contract-tested against —
 * bumping requires checking the official changelog
 * (https://developers.facebook.com/docs/graph-api/changelog/versions) and
 * running the tests; NEVER blind-bump. The env override META_GRAPH_VERSION pins
 * a version without a repo-wide edit.
 */

/** The version this codebase is contract-tested against. */
export const META_GRAPH_DEFAULT_VERSION = 'v21.0'

const VERSION_RE = /^v\d{2}\.\d$/

/** Resolve the Graph version: env override (validated) or the tested default. */
export function metaGraphVersion(): string {
  const env = process.env.META_GRAPH_VERSION?.trim()
  if (env) {
    if (VERSION_RE.test(env)) return env
    console.warn(`[meta-version] ignoring invalid META_GRAPH_VERSION "${env}" — using ${META_GRAPH_DEFAULT_VERSION}`)
  }
  return META_GRAPH_DEFAULT_VERSION
}

/** e.g. https://graph.facebook.com/v21.0 */
export function metaGraphBase(): string {
  return `https://graph.facebook.com/${metaGraphVersion()}`
}

export type MetaErrorKind =
  | 'auth' // token invalid/expired — owner must re-issue
  | 'permission' // scope/asset permission missing
  | 'rate_limit' // back off and retry later
  | 'validation' // our request is wrong — do not retry as-is
  | 'server' // Meta-side failure — retryable
  | 'network' // transport failure — retryable
  | 'unknown'

export interface MetaErrorClassification {
  kind: MetaErrorKind
  retryable: boolean
  code: number | null
  subcode: number | null
  fbtraceId: string | null
  /** What the owner (non-engineer) should do, in one sentence. */
  ownerAction: string
  message: string
}

interface MetaErrorBody {
  error?: {
    message?: string
    code?: number
    error_subcode?: number
    fbtrace_id?: string
    type?: string
  }
}

/**
 * Classify a Meta Graph error response. Codes per Meta docs:
 * 190 = token, 10/200–299 = permission, 4/17/32/613 = rate limit,
 * 100 = validation, 1/2 = temporary server issue.
 */
export function classifyMetaError(status: number, body: MetaErrorBody | null): MetaErrorClassification {
  const err = body?.error
  const code = err?.code ?? null
  const subcode = err?.error_subcode ?? null
  const fbtraceId = err?.fbtrace_id ?? null
  const message = err?.message ?? `HTTP ${status}`

  const mk = (kind: MetaErrorKind, retryable: boolean, ownerAction: string): MetaErrorClassification => ({
    kind, retryable, code, subcode, fbtraceId, ownerAction, message,
  })

  if (code === 190) return mk('auth', false, 'Meta token মেয়াদ শেষ/অবৈধ — নতুন token issue করে env আপডেট করতে হবে।')
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return mk('permission', false, 'এই asset/scope-এ permission নেই — Business Manager-এ access দিতে হবে।')
  }
  if (code === 4 || code === 17 || code === 32 || code === 613) {
    return mk('rate_limit', true, 'Meta rate limit — কিছুক্ষণ পরে আবার চেষ্টা হবে, কিছু করার দরকার নেই।')
  }
  if (code === 100) return mk('validation', false, 'Request-টাই ভুল ছিল — এজেন্ট ঠিক করে আবার পাঠাবে; আপনার কিছু করার নেই।')
  if (code === 1 || code === 2 || status >= 500) return mk('server', true, 'Meta-র সাময়িক সমস্যা — retry হবে।')
  if (status === 0) return mk('network', true, 'নেটওয়ার্ক সমস্যা — retry হবে।')
  return mk('unknown', false, `অজানা Meta error (code=${code ?? 'n/a'}, fbtrace=${fbtraceId ?? 'n/a'}) — এজেন্টকে দেখতে বলুন।`)
}
