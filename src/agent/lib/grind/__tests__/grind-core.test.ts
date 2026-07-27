/**
 * The grind engine's invariants, pinned as arithmetic.
 *
 * I1 — a model can never write `fixed`.
 * I2 — no second execution surface (structural; not testable here).
 * I3 — completion is a count, not a claim.
 */
import { describe, it, expect } from 'vitest'
import { buildCampaignSteps, GRIND_STEP_TOOL } from '@/agent/lib/grind/step-builder'
import { decideVerification } from '@/agent/lib/grind/step-verifier'
import { gateFindings, hasUsableRootCause, MIN_ROOT_CAUSE_CHARS } from '@/agent/lib/grind/diagnosis-gate'
import { tallyFindings, fingerprintOf, type FindingRow, type FindingStatus } from '@/agent/lib/grind/finding-set'
import { grindHeadline } from '@/agent/lib/grind/completion'
import { ingestSeoAudit } from '@/agent/lib/grind/adapters'
import { diffAudits, type AuditJson } from '@/agent/lib/seo-report'
import { measurePageIssues } from '@/agent/lib/grind/page-measure'

const finding = (over: Partial<FindingRow> & { scope: string; code: string }): FindingRow => ({
  id: `${over.scope}|${over.code}`,
  setId: 'set-1',
  fingerprint: fingerprintOf(over.scope, over.code),
  family: over.code,
  severity: 'medium',
  detail: null,
  status: 'open' as FindingStatus,
  rootCause: null,
  rootCauseRef: null,
  batchKey: null,
  stepId: null,
  note: null,
  introduced: false,
  reMeasuredAt: null,
  fixedAt: null,
  ...over,
})

describe('fingerprints match the client report exactly', () => {
  it('ingest uses the SAME key the before/after comparison uses', () => {
    const audit = {
      url: 'https://x.com', score: 50, counts: { critical: 0, high: 1, medium: 0, low: 0 },
      siteChecks: { issues: [{ severity: 'high' as const, code: 'broken_pages', detail: '2টা' }] },
      pages: [{ url: 'https://x.com/a', issues: [{ severity: 'high' as const, code: 'missing_h1', detail: 'নেই' }] }],
    } satisfies AuditJson

    const inputs = ingestSeoAudit(audit)
    const keys = inputs.map((i) => fingerprintOf(i.scope, i.code))
    expect(keys).toEqual(['site|broken_pages', 'https://x.com/a|missing_h1'])

    // diffAudits (which the client report renders) computes identical keys, so
    // "resolved" in the report and "fixed" in the store can never disagree.
    const after = { ...audit, siteChecks: { issues: [] }, pages: [] }
    const diff = diffAudits(audit, after)
    expect(diff.resolved.map((i) => `${i.scope}|${i.code}`)).toEqual(keys)
  })
})

describe('step-builder — 246 findings become a deterministic graph', () => {
  const many = Array.from({ length: 246 }, (_, i) =>
    finding({
      scope: `https://x.com/p${i}`,
      code: ['missing_h1', 'thin_content', 'missing_meta_description', 'missing_img_alt'][i % 4],
      severity: i % 4 === 0 ? 'high' : 'medium',
    }),
  )

  it('groups by family and orders diagnose → fix → verify', () => {
    const built = buildCampaignSteps({ target: 'x.com', findings: many })

    expect(built.familyCount).toBe(4)
    // Every fix step depends on its family's diagnose step — that dependency IS
    // what makes fixing-before-diagnosing impossible.
    const fixSteps = built.steps.filter((s) => s.toolName === GRIND_STEP_TOOL.fix)
    expect(fixSteps.length).toBeGreaterThan(0)
    for (const fix of fixSteps) expect(fix.dependsOn).toHaveLength(1)

    // Nothing is dropped: every finding appears in exactly one fix batch.
    const covered = fixSteps.flatMap((s) => s.fingerprints)
    expect(new Set(covered).size).toBe(246)

    // Each fix batch has its own verify.
    const verifies = built.steps.filter((s) => s.toolName === GRIND_STEP_TOOL.verify)
    expect(verifies).toHaveLength(fixSteps.length)
  })

  it('sweeps for regressions periodically and always ends on a full re-measure', () => {
    const built = buildCampaignSteps({ target: 'x.com', findings: many })
    const sweeps = built.steps.filter((s) => s.toolName === GRIND_STEP_TOOL.regression)
    expect(sweeps.length).toBeGreaterThan(1)
    expect(built.steps[built.steps.length - 1].toolName).toBe(GRIND_STEP_TOOL.regression)
  })

  it('worst severity first — Boss gets the serious problems fixed first', () => {
    const built = buildCampaignSteps({
      target: 'x.com',
      findings: [
        finding({ scope: 'https://x.com/a', code: 'missing_img_alt', severity: 'low' }),
        finding({ scope: 'https://x.com/b', code: 'noindex', severity: 'critical' }),
      ],
    })
    expect(built.steps[0].family).toBe('noindex')
  })
})

describe('diagnosis gate — no fix without a real root cause', () => {
  it('rejects a short cause, a missing cause, and a vague reference', () => {
    expect(hasUsableRootCause({ rootCause: 'template issue', rootCauseRef: 'app/page.tsx:12' })).toBe(false)
    expect(hasUsableRootCause({ rootCause: 'x'.repeat(MIN_ROOT_CAUSE_CHARS), rootCauseRef: null })).toBe(false)
    expect(hasUsableRootCause({ rootCause: 'x'.repeat(MIN_ROOT_CAUSE_CHARS), rootCauseRef: 'somewhere' })).toBe(false)
  })

  it('accepts an explanation with a concrete file:line or URL', () => {
    const cause = 'The product template renders no <h1>; the title is an <h2> inside the gallery block.'
    expect(hasUsableRootCause({ rootCause: cause, rootCauseRef: 'app/products/[slug]/page.tsx:48' })).toBe(true)
    expect(hasUsableRootCause({ rootCause: cause, rootCauseRef: 'https://almatraders.com/products/x' })).toBe(true)
  })

  it('an empty batch is NOT ready — "nothing to check" must never mean "go ahead"', () => {
    expect(gateFindings([]).ready).toBe(false)
  })

  it('names exactly which findings still lack a cause', () => {
    const cause = 'The category template omits the meta description entirely for paginated pages.'
    const verdict = gateFindings([
      finding({ scope: 'https://x.com/a', code: 'missing_h1', rootCause: cause, rootCauseRef: 'app/x.tsx:10' }),
      finding({ scope: 'https://x.com/b', code: 'missing_h1' }),
    ])
    expect(verdict.ready).toBe(false)
    expect(verdict.missing).toEqual(['https://x.com/b|missing_h1'])
  })
})

describe('step-verifier — measurement decides, not the agent', () => {
  const batch = [
    finding({ scope: 'https://x.com/a', code: 'missing_h1' }),
    finding({ scope: 'https://x.com/b', code: 'missing_h1' }),
    finding({ scope: 'site', code: 'missing_sitemap' }),
  ]

  it('fixed only when the fingerprint is gone from a scope we actually measured', () => {
    const decision = decideVerification(batch, {
      present: new Set(['https://x.com/b|missing_h1']),
      measuredScopes: ['https://x.com/a', 'https://x.com/b'],
    })
    expect(decision.fixed).toEqual(['https://x.com/a|missing_h1'])
    expect(decision.stillPresent).toEqual(['https://x.com/b|missing_h1'])
    // The site-level finding was not measurable here — unknown, NOT fixed.
    expect(decision.unverifiable).toEqual(['site|missing_sitemap'])
  })

  it('a scope we could not fetch is never counted as fixed', () => {
    const decision = decideVerification(batch, { present: new Set(), measuredScopes: [] })
    expect(decision.fixed).toEqual([])
    expect(decision.unverifiable).toHaveLength(3)
  })
})

describe('completion is arithmetic (I3)', () => {
  const rows = (statuses: FindingStatus[]) =>
    statuses.map((status, i) => finding({ scope: `https://x.com/${i}`, code: 'missing_h1', status }))

  it('a claim alone never counts as fixed', () => {
    const t = tallyFindings(rows(['fixed', 'fix_claimed', 'fixed']))
    expect(t.fixed).toBe(2)
    expect(t.claimedOnly).toBe(1)
  })

  it('counts what is still outstanding, per status and per family', () => {
    const t = tallyFindings([
      finding({ scope: 'a', code: 'missing_h1', status: 'fixed' }),
      finding({ scope: 'b', code: 'missing_h1', status: 'open' }),
      finding({ scope: 'c', code: 'thin_content', status: 'regressed' }),
      finding({ scope: 'd', code: 'thin_content', status: 'wont_fix' }),
      finding({ scope: 'e', code: 'noindex', status: 'open', introduced: true }),
    ])
    expect(t.open).toBe(2)
    expect(t.regressed).toBe(1)
    expect(t.wontFix).toBe(1)
    expect(t.introduced).toBe(1)
    expect(t.byFamily.find((f) => f.family === 'missing_h1')).toEqual({ family: 'missing_h1', total: 2, fixed: 1, open: 1 })
  })

  it('headline speaks measured numbers in Bangla', () => {
    const t = tallyFindings(rows(['fixed', 'fixed', 'open']))
    expect(grindHeadline(t)).toContain('৩ টার মধ্যে ২ টা ঠিক হয়েছে')
    expect(grindHeadline(t)).toContain('০ নতুন সমস্যা')
  })
})

describe('page re-measure mirrors the crawler codes', () => {
  it('a broken page produces the codes the audit would have produced', () => {
    const bad = `<html><head><meta name="robots" content="noindex"><title>Hi</title></head>
      <body><img src="http://insecure/x.jpg"><a href="/n">n</a></body></html>`
    const codes = measurePageIssues(bad, 'https://x.com/bad').map((i) => i.code)
    for (const expected of [
      'noindex', 'short_title', 'missing_meta_description', 'missing_viewport',
      'missing_canonical', 'missing_structured_data', 'thin_content', 'mixed_content',
      'missing_h1', 'missing_lang', 'incomplete_open_graph',
    ]) {
      expect(codes).toContain(expected)
    }
  })

  it('a healthy page produces no page-level issues worth fixing', () => {
    const good = `<!doctype html><html lang="bn"><head>
      <meta name="viewport" content="width=device-width">
      <title>Premium Panjabi Collection — ALMA</title>
      <meta name="description" content="${'ভালো বর্ণনা '.repeat(6)}">
      <link rel="canonical" href="https://x.com/a">
      <meta property="og:title" content="t"><meta property="og:image" content="i">
      <script type="application/ld+json">{"@type":"Product"}</script>
      </head><body><h1>Panjabi</h1><p>${'শব্দ '.repeat(200)}</p>
      <img src="/a.jpg" alt="panjabi"></body></html>`
    expect(measurePageIssues(good, 'https://x.com/a')).toEqual([])
  })
})
