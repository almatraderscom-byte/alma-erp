/**
 * Grind adapters — the ONLY things that know how a kind of finding is measured.
 *
 * Contract (deliberately tiny, so a new source is a small file, not a new
 * engine):
 *   ingest(raw)                → FindingInput[]      — measurement → findings
 *   reMeasure(set, scopes?)    → { present: Set }    — what is STILL true now
 *
 * Everything above this layer is set arithmetic over fingerprints. That is what
 * makes "done" a count rather than a claim.
 */
import type { FindingInput, FindingSetRow, FindingSource } from '@/agent/lib/grind/finding-set'
import { fingerprintOf } from '@/agent/lib/grind/finding-set'
import { flattenIssues, type AuditJson } from '@/agent/lib/seo-report'
import { measurePageIssues, PAGE_LEVEL_CODES, unsafeMeasureUrlReason } from '@/agent/lib/grind/page-measure'

export interface ReMeasureResult {
  /** Fingerprints observed as STILL PRESENT in the re-measured scopes. */
  present: Set<string>
  /** Scopes actually measured — anything outside is untouched, not "fixed". */
  measuredScopes: string[]
  /** Scopes we could not measure (fetch failed) — treated as "unknown", never "fixed". */
  unmeasuredScopes: string[]
}

export interface GrindAdapter {
  source: FindingSource
  /** Can this adapter re-measure one scope on its own (without a full re-run)? */
  supportsScopedReMeasure: boolean
  ingest(raw: unknown): FindingInput[]
  reMeasure(set: FindingSetRow, scopes?: string[]): Promise<ReMeasureResult>
}

// ── SEO audit ───────────────────────────────────────────────────────────────

/**
 * An `audit.json` from the worker crawl → findings. The fingerprint is
 * `${scope}|${code}`, byte-identical to the key the before/after client report
 * uses, so the campaign and that report cannot disagree.
 */
export function ingestSeoAudit(raw: unknown): FindingInput[] {
  const audit = raw as AuditJson
  if (!audit || typeof audit !== 'object') return []
  return flattenIssues(audit).map((i) => ({
    scope: i.scope,
    code: i.code,
    severity: i.severity,
    detail: i.detail,
    // One issue code IS one fix family: same cause, same remedy, same reviewer
    // decision. 246 findings collapse to ~15-25 families this way.
    family: i.code,
  }))
}

const FETCH_TIMEOUT_MS = 15_000

async function fetchPage(url: string): Promise<{ ok: true; html: string } | { ok: false; error: string }> {
  const unsafe = unsafeMeasureUrlReason(url)
  if (unsafe) return { ok: false, error: unsafe }
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'ALMA-Agent-SEO/1.0 (+https://almatraders.com)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (!/html/i.test(type)) return { ok: false, error: `content-type ${type || 'unknown'}` }
    return { ok: true, html: await res.text() }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export const seoAuditAdapter: GrindAdapter = {
  source: 'seo_audit',
  supportsScopedReMeasure: true,
  ingest: ingestSeoAudit,
  async reMeasure(_set, scopes) {
    const present = new Set<string>()
    const measured: string[] = []
    const unmeasured: string[] = []

    // Only page scopes can be re-measured here. 'site' scopes (sitemap, https,
    // broken pages) need the full crawl — they are reported as unmeasured so the
    // verifier leaves those findings alone instead of calling them fixed.
    for (const scope of scopes ?? []) {
      if (scope === 'site') {
        unmeasured.push(scope)
        continue
      }
      const res = await fetchPage(scope)
      if (!res.ok) {
        unmeasured.push(scope)
        continue
      }
      measured.push(scope)
      for (const issue of measurePageIssues(res.html, scope)) {
        present.add(fingerprintOf(scope, issue.code))
      }
    }

    return { present, measuredScopes: measured, unmeasuredScopes: unmeasured }
  },
}

/** Codes this engine can decide from a scoped re-measure. */
export function isScopedVerifiable(code: string): boolean {
  return PAGE_LEVEL_CODES.has(code)
}

// ── Website health scan ─────────────────────────────────────────────────────

interface HealthScanIssue {
  code?: string
  severity?: string
  scope?: string
  entity?: string
  detail?: string
  message?: string
}

/**
 * The website consistency/health scan (ERP catalogue vs live site). Its scope is
 * an entity id, not a URL, so the re-measure is a full re-scan — cheap enough
 * that scoping it buys nothing.
 */
export function ingestHealthScan(raw: unknown): FindingInput[] {
  const issues = Array.isArray(raw)
    ? (raw as HealthScanIssue[])
    : ((raw as { issues?: HealthScanIssue[] } | null)?.issues ?? [])
  return issues
    .filter((i) => i && (i.code || i.message))
    .map((i) => ({
      scope: String(i.scope ?? i.entity ?? 'site'),
      code: String(i.code ?? 'health_issue'),
      severity: String(i.severity ?? 'medium'),
      detail: i.detail ?? i.message ?? null,
      family: String(i.code ?? 'health_issue'),
    }))
}

export const healthScanAdapter: GrindAdapter = {
  source: 'health_scan',
  supportsScopedReMeasure: false,
  ingest: ingestHealthScan,
  async reMeasure() {
    // A full re-scan is driven as a plan step (run_health_scan → ingest), so the
    // verifier must not treat "I cannot measure this myself" as "it is fixed".
    return { present: new Set<string>(), measuredScopes: [], unmeasuredScopes: ['*'] }
  },
}

// ── Product SEO ─────────────────────────────────────────────────────────────

interface ProductSeoIssue {
  productId?: string | number
  slug?: string
  url?: string
  code?: string
  severity?: string
  detail?: string
}

/** audit_product_seo output → findings, scoped by the product's live URL. */
export function ingestProductSeo(raw: unknown): FindingInput[] {
  const rows = Array.isArray(raw)
    ? (raw as ProductSeoIssue[])
    : ((raw as { issues?: ProductSeoIssue[] } | null)?.issues ?? [])
  return rows
    .filter((r) => r && r.code)
    .map((r) => ({
      scope: String(r.url ?? r.slug ?? r.productId ?? 'catalogue'),
      code: String(r.code),
      severity: String(r.severity ?? 'medium'),
      detail: r.detail ?? null,
      family: String(r.code),
    }))
}

export const productSeoAdapter: GrindAdapter = {
  source: 'product_seo',
  supportsScopedReMeasure: true,
  ingest: ingestProductSeo,
  async reMeasure(set, scopes) {
    // Product pages are ordinary URLs when we have them; anything else defers to
    // the full re-run.
    const urlScopes = (scopes ?? []).filter((s) => /^https?:\/\//i.test(s))
    const other = (scopes ?? []).filter((s) => !/^https?:\/\//i.test(s))
    const res = await seoAuditAdapter.reMeasure(set, urlScopes)
    return { ...res, unmeasuredScopes: [...res.unmeasuredScopes, ...other] }
  },
}

const ADAPTERS: Record<FindingSource, GrindAdapter> = {
  seo_audit: seoAuditAdapter,
  health_scan: healthScanAdapter,
  product_seo: productSeoAdapter,
}

export function adapterFor(source: FindingSource): GrindAdapter {
  return ADAPTERS[source]
}
