/**
 * The findings store — the campaign ledger the grind engine grinds through.
 *
 * Everything downstream (step building, verification, regression detection,
 * completion) is SET ARITHMETIC over fingerprints, so the interesting decisions
 * are made by counting rather than by asking a model whether it feels done.
 *
 * INVARIANT I1 — the model can never write `fixed`.
 * `markFixed` is called only by the deterministic step-verifier, from a
 * re-measurement by the same pipeline that produced the finding. An LLM verdict
 * can reach at most `fix_claimed`, which the end-of-campaign full re-measure has
 * to confirm. Every writer here is typed accordingly.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type FindingSource = 'seo_audit' | 'health_scan' | 'product_seo'

export type FindingStatus =
  /** measured, nothing done yet */
  | 'open'
  /** a fix step is running for it */
  | 'in_progress'
  /** the agent says it fixed it — NOT proof; a re-measure must confirm */
  | 'fix_claimed'
  /** re-measured and genuinely gone (only step-verifier writes this) */
  | 'fixed'
  /** was gone (or never there) and came back / appeared after our fix */
  | 'regressed'
  /** the root cause did not explain it — must be diagnosed again */
  | 'needs_rediagnosis'
  /** deliberately not fixing (owner decision or out of our reach) */
  | 'wont_fix'

export type SetStatus = 'open' | 'complete' | 'halted'

export interface FindingInput {
  scope: string
  code: string
  severity: string
  detail?: string | null
  /** Defaults to `code` — issues of one code share a root cause and one fix. */
  family?: string
}

export interface FindingRow {
  id: string
  setId: string
  fingerprint: string
  scope: string
  code: string
  family: string
  severity: string
  detail: string | null
  status: FindingStatus
  rootCause: string | null
  rootCauseRef: string | null
  batchKey: string | null
  stepId: string | null
  note: string | null
  introduced: boolean
  reMeasuredAt: Date | null
  fixedAt: Date | null
}

export interface FindingSetRow {
  id: string
  businessId: string
  source: FindingSource
  target: string
  label: string | null
  status: SetStatus
  planId: string | null
  conversationId: string | null
  baselineRef: string | null
  haltReason: string | null
  regressionCount: number
  lastMeasuredAt: Date | null
  lastFixAt: Date | null
}

/**
 * The identity of a finding. Byte-identical to the key `buildCompareMarkdown`
 * uses in seo-report.ts — if these two ever drift, the store and the client's
 * before/after report would disagree about what got fixed.
 */
export function fingerprintOf(scope: string, code: string): string {
  return `${scope}|${code}`
}

/** Terminal-ish statuses that no longer count as work outstanding. */
const CLOSED: ReadonlySet<FindingStatus> = new Set<FindingStatus>(['fixed', 'wont_fix'])

export function isClosed(status: FindingStatus): boolean {
  return CLOSED.has(status)
}

// ── Set lifecycle ───────────────────────────────────────────────────────────

export async function createFindingSet(input: {
  source: FindingSource
  target: string
  businessId?: string
  label?: string
  conversationId?: string | null
  baselineRef?: string | null
}): Promise<FindingSetRow> {
  return db.agentFindingSet.create({
    data: {
      source: input.source,
      target: input.target,
      businessId: input.businessId ?? 'ALMA_LIFESTYLE',
      label: input.label ?? null,
      conversationId: input.conversationId ?? null,
      baselineRef: input.baselineRef ?? null,
      lastMeasuredAt: new Date(),
    },
  })
}

export async function loadFindingSet(setId: string): Promise<FindingSetRow | null> {
  return db.agentFindingSet.findUnique({ where: { id: setId } })
}

export async function attachPlan(setId: string, planId: string): Promise<void> {
  await db.agentFindingSet.update({ where: { id: setId }, data: { planId } })
}

export async function setSetStatus(setId: string, status: SetStatus, haltReason?: string): Promise<void> {
  await db.agentFindingSet.update({
    where: { id: setId },
    data: { status, ...(haltReason !== undefined ? { haltReason } : {}) },
  })
}

/** The open campaign for a target, if one is already running (dedupe). */
export async function findOpenSet(source: FindingSource, target: string): Promise<FindingSetRow | null> {
  return db.agentFindingSet.findFirst({
    where: { source, target, status: 'open' },
    orderBy: { createdAt: 'desc' },
  })
}

// ── Findings ────────────────────────────────────────────────────────────────

/**
 * Add measured findings to a set. Idempotent per fingerprint: re-ingesting the
 * same audit refreshes `lastSeenAt` rather than duplicating the campaign.
 *
 * `introducedAfter` marks findings that were NOT in the baseline — a regression
 * we caused. They are ingested exactly like any other finding (so the completion
 * arithmetic blocks on them) but flagged so the owner sees what we broke.
 */
export async function ingestFindings(
  setId: string,
  inputs: FindingInput[],
  opts: { introduced?: boolean; now?: Date } = {},
): Promise<{ added: number; refreshed: number }> {
  const now = opts.now ?? new Date()
  let added = 0
  let refreshed = 0

  for (const input of inputs) {
    const fingerprint = fingerprintOf(input.scope, input.code)
    const existing = await db.agentFinding.findUnique({
      where: { setId_fingerprint: { setId, fingerprint } },
      select: { id: true },
    })
    if (existing) {
      await db.agentFinding.update({ where: { id: existing.id }, data: { lastSeenAt: now } })
      refreshed++
      continue
    }
    await db.agentFinding.create({
      data: {
        setId,
        fingerprint,
        scope: input.scope,
        code: input.code,
        family: input.family ?? input.code,
        severity: input.severity,
        detail: input.detail ?? null,
        status: 'open',
        introduced: opts.introduced === true,
        firstSeenAt: now,
        lastSeenAt: now,
      },
    })
    added++
  }

  await db.agentFindingSet.update({ where: { id: setId }, data: { lastMeasuredAt: now } }).catch(() => {})
  return { added, refreshed }
}

export async function listFindings(
  setId: string,
  where: { status?: FindingStatus | FindingStatus[]; family?: string; batchKey?: string } = {},
): Promise<FindingRow[]> {
  return db.agentFinding.findMany({
    where: {
      setId,
      ...(where.status ? { status: Array.isArray(where.status) ? { in: where.status } : where.status } : {}),
      ...(where.family ? { family: where.family } : {}),
      ...(where.batchKey ? { batchKey: where.batchKey } : {}),
    },
    orderBy: [{ severity: 'asc' }, { fingerprint: 'asc' }],
  })
}

/** Findings grouped by family, worst severity first — the step-builder's input. */
export async function familiesOf(setId: string): Promise<Array<{ family: string; findings: FindingRow[] }>> {
  const rows = await listFindings(setId)
  const byFamily = new Map<string, FindingRow[]>()
  for (const r of rows) {
    const list = byFamily.get(r.family)
    if (list) list.push(r)
    else byFamily.set(r.family, [r])
  }
  const rank = (s: string) => ['critical', 'high', 'medium', 'low'].indexOf(s)
  return [...byFamily.entries()]
    .map(([family, findings]) => ({ family, findings }))
    .sort((a, b) => {
      const sa = Math.min(...a.findings.map((f) => (rank(f.severity) < 0 ? 9 : rank(f.severity))))
      const sb = Math.min(...b.findings.map((f) => (rank(f.severity) < 0 ? 9 : rank(f.severity))))
      return sa !== sb ? sa - sb : b.findings.length - a.findings.length
    })
}

// ── Status writers (the I1 boundary lives here) ─────────────────────────────

export async function markInProgress(ids: string[], stepId: string, batchKey: string): Promise<void> {
  if (ids.length === 0) return
  await db.agentFinding.updateMany({
    where: { id: { in: ids }, status: { in: ['open', 'needs_rediagnosis', 'regressed'] } },
    data: { status: 'in_progress', stepId, batchKey },
  })
}

/**
 * The MOST a model-authored fix may write. Never 'fixed' — that word belongs to
 * the deterministic verifier alone.
 */
export async function markFixClaimed(ids: string[], note?: string): Promise<void> {
  if (ids.length === 0) return
  await db.agentFinding.updateMany({
    where: { id: { in: ids } },
    data: { status: 'fix_claimed', ...(note ? { note: note.slice(0, 500) } : {}) },
  })
}

/**
 * Deterministic verification said the problem is genuinely gone.
 * ONLY step-verifier.ts calls this.
 */
export async function markFixed(ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return
  await db.agentFinding.updateMany({
    where: { id: { in: ids } },
    data: { status: 'fixed', fixedAt: now, reMeasuredAt: now },
  })
}

/** Deterministic verification said it is STILL there — back to open, with a note. */
export async function markStillPresent(ids: string[], note: string, now = new Date()): Promise<void> {
  if (ids.length === 0) return
  await db.agentFinding.updateMany({
    where: { id: { in: ids } },
    data: { status: 'open', note: note.slice(0, 500), reMeasuredAt: now },
  })
}

export async function markRegressed(ids: string[], note: string, now = new Date()): Promise<void> {
  if (ids.length === 0) return
  await db.agentFinding.updateMany({
    where: { id: { in: ids } },
    data: { status: 'regressed', note: note.slice(0, 500), reMeasuredAt: now },
  })
}

export async function markNeedsRediagnosis(ids: string[], why: string): Promise<void> {
  if (ids.length === 0) return
  await db.agentFinding.updateMany({
    where: { id: { in: ids } },
    // Its own family, so a wrong grouping cannot drag the finding down with it.
    data: { status: 'needs_rediagnosis', note: why.slice(0, 500), rootCause: null, rootCauseRef: null },
  })
}

export async function recordRootCause(input: {
  setId: string
  fingerprints: string[]
  rootCause: string
  ref: string
}): Promise<number> {
  if (input.fingerprints.length === 0) return 0
  const res = await db.agentFinding.updateMany({
    where: { setId: input.setId, fingerprint: { in: input.fingerprints } },
    data: { rootCause: input.rootCause.slice(0, 2000), rootCauseRef: input.ref.slice(0, 500) },
  })
  return res?.count ?? 0
}

export async function stampFixApplied(setId: string, now = new Date()): Promise<void> {
  await db.agentFindingSet.update({ where: { id: setId }, data: { lastFixAt: now } }).catch(() => {})
}

export async function bumpRegressionCount(setId: string): Promise<number> {
  const row = await db.agentFindingSet.update({
    where: { id: setId },
    data: { regressionCount: { increment: 1 } },
    select: { regressionCount: true },
  })
  return row?.regressionCount ?? 0
}

// ── Campaign arithmetic (INVARIANT I3) ──────────────────────────────────────

export interface GrindTally {
  total: number
  open: number
  inProgress: number
  claimedOnly: number
  fixed: number
  regressed: number
  needsRediagnosis: number
  wontFix: number
  introduced: number
  byFamily: Array<{ family: string; total: number; fixed: number; open: number }>
}

/** Pure counting over rows — no DB, no model, unit-testable. */
export function tallyFindings(rows: FindingRow[]): GrindTally {
  const t: GrindTally = {
    total: rows.length,
    open: 0,
    inProgress: 0,
    claimedOnly: 0,
    fixed: 0,
    regressed: 0,
    needsRediagnosis: 0,
    wontFix: 0,
    introduced: 0,
    byFamily: [],
  }
  const fam = new Map<string, { total: number; fixed: number; open: number }>()
  for (const r of rows) {
    switch (r.status) {
      case 'open': t.open++; break
      case 'in_progress': t.inProgress++; break
      case 'fix_claimed': t.claimedOnly++; break
      case 'fixed': t.fixed++; break
      case 'regressed': t.regressed++; break
      case 'needs_rediagnosis': t.needsRediagnosis++; break
      case 'wont_fix': t.wontFix++; break
    }
    if (r.introduced && r.status !== 'fixed') t.introduced++
    const f = fam.get(r.family) ?? { total: 0, fixed: 0, open: 0 }
    f.total++
    if (r.status === 'fixed') f.fixed++
    else if (!isClosed(r.status)) f.open++
    fam.set(r.family, f)
  }
  t.byFamily = [...fam.entries()].map(([family, v]) => ({ family, ...v }))
  return t
}

export async function tallySet(setId: string): Promise<GrindTally> {
  return tallyFindings(await listFindings(setId))
}
