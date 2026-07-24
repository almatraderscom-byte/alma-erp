/**
 * Monthly cost reconciliation — local ESTIMATE vs provider-PUBLISHED bill.
 *
 * Cost audit 2026-07-25. The per-call reconciler (finops/reconciliation.ts)
 * checks one API call's estimate against its own reported usage. This module
 * works at the month/provider grain — the level where the 2026-07-24 incident
 * lived: our local dashboard read $4.04/day of "voice" while OpenAI's own
 * published cost for the whole month was $2.71. Nobody was comparing the two, so
 * a 30x-wrong estimate looked like truth.
 *
 * For every provider that both (a) we meter locally in agent_cost_events AND
 * (b) publishes an authoritative cost number, we compare our local sum for the
 * SAME window (month start → the provider's sync boundary) against the published
 * figure and surface the drift. Large drift = our cost MODEL is wrong for that
 * provider (bad per-unit rate, misattributed bucket, double-count) — exactly the
 * class of bug the owner hit. Read-only; never mutates spend.
 */
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { EFFECTIVE_PROVIDER_SQL, getApiBalances, type BalanceProviderRow } from '@/agent/lib/api-balances'
import { todayYmdDhaka, dhakaDayBounds } from '@/lib/agent-api/dhaka-date'

/**
 * Providers we bill locally into agent_cost_events (so a drift check is
 * meaningful). Everything else — vercel/supabase (infra), fal/fashn/oxylabs
 * (prepaid credits, non-USD units) — has no per-call local USD estimate to
 * reconcile, and is reported separately.
 */
const AGENT_METERED = new Set<string>([
  'anthropic', 'openai', 'openrouter', 'gemini', 'xai',
  'google_tts', 'elevenlabs', 'twilio', 'veo',
])

export type ReconcileStatus =
  | 'RECONCILED' // local ≈ provider (within tolerance)
  | 'LOCAL_HIGH' // local estimate materially ABOVE the real bill (over-billing the dashboard)
  | 'LOCAL_LOW' // local estimate materially BELOW the real bill (under-counting)
  | 'UNVERIFIED' // agent-metered but provider publishes no authoritative cost (estimate only)
  | 'INFRA' // published cost with no local counterpart (vercel/supabase) — informational
  | 'NO_DATA' // neither side has a number

export interface ProviderReconcile {
  id: string
  label: string
  providerActualUsd: number | null // published bill through `syncedThrough`
  localEstimateUsd: number | null // our agent_cost_events sum for the same window
  syncedThrough: string | null
  driftUsd: number | null // local - provider (positive = we over-estimate)
  driftPct: number | null // driftUsd / provider (null when provider is 0/unknown)
  status: ReconcileStatus
  note: string
}

export interface MonthlyReconciliation {
  month: string // YYYY-MM (Dhaka)
  checkedAt: string
  tolerancePct: number
  toleranceUsd: number
  totals: {
    // Only over the reconcilable (agent-metered + authoritative) providers, so
    // the numbers are like-for-like and the drift total is meaningful.
    providerActualUsd: number
    localEstimateUsd: number
    driftUsd: number
  }
  providers: ProviderReconcile[]
  flagged: ProviderReconcile[] // LOCAL_HIGH / LOCAL_LOW beyond tolerance, worst first
}

// A provider needs BOTH a big relative AND a real absolute gap before we call it
// drift — a 90% miss on $0.02 is noise; $3 on $2.71 is the real incident.
const DEFAULT_TOLERANCE_PCT = 20
const DEFAULT_TOLERANCE_USD = 1

function roundUsd(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Compare local vs published spend per provider for the current Dhaka month.
 * `balances` is injectable for tests; defaults to the live balance snapshot.
 */
export async function computeMonthlyReconciliation(opts?: {
  balances?: BalanceProviderRow[]
  tolerancePct?: number
  toleranceUsd?: number
}): Promise<MonthlyReconciliation> {
  const today = todayYmdDhaka()
  const monthStart = dhakaDayBounds(`${today.slice(0, 7)}-01`).start
  const balances = opts?.balances ?? (await getApiBalances()).providers

  // Local spend by effective provider, one query per distinct sync boundary so
  // each provider is compared over EXACTLY the window its published figure
  // covers (boundaries usually coincide, so this is 1–2 queries in practice).
  const boundaryEnds = new Map<string, Date>() // syncedThrough ('now' sentinel for null) → window end
  for (const row of balances) {
    if (!row.costAuthoritative || row.providerMonthUsd == null) continue
    if (!AGENT_METERED.has(row.id)) continue
    const key = row.syncedThrough ?? 'now'
    if (!boundaryEnds.has(key)) {
      boundaryEnds.set(key, row.syncedThrough ? dhakaDayBounds(row.syncedThrough).end : new Date())
    }
  }
  const localByBoundary = new Map<string, Record<string, number>>()
  for (const [key, end] of boundaryEnds) {
    localByBoundary.set(key, await queryLocalSpendByProvider(monthStart, end))
  }

  return buildReconciliation(balances, (id, syncedThrough) =>
    localByBoundary.get(syncedThrough ?? 'now')?.[id] ?? 0, opts)
}

/**
 * Pure reconciliation core — no DB, no network. `localLookup(providerId,
 * syncedThrough)` returns the local agent_cost_events sum for that provider over
 * the window its published figure covers. Exposed for unit tests.
 */
export function buildReconciliation(
  balances: BalanceProviderRow[],
  localLookup: (providerId: string, syncedThrough: string | null) => number,
  opts?: { tolerancePct?: number; toleranceUsd?: number },
): MonthlyReconciliation {
  const tolerancePct = opts?.tolerancePct ?? DEFAULT_TOLERANCE_PCT
  const toleranceUsd = opts?.toleranceUsd ?? DEFAULT_TOLERANCE_USD
  const month = todayYmdDhaka().slice(0, 7)

  const providers: ProviderReconcile[] = balances.map((row): ProviderReconcile => {
    const metered = AGENT_METERED.has(row.id)
    const hasPublished = row.costAuthoritative && row.providerMonthUsd != null

    // Published cost but nothing to reconcile against locally (vercel/supabase).
    if (hasPublished && !metered) {
      return {
        id: row.id,
        label: row.label,
        providerActualUsd: roundUsd(row.providerMonthUsd as number),
        localEstimateUsd: null,
        syncedThrough: row.syncedThrough ?? null,
        driftUsd: null,
        driftPct: null,
        status: 'INFRA',
        note: 'External/infra cost — agent estimate করে না, তাই reconcile নয়।',
      }
    }

    if (hasPublished && metered) {
      const local = localLookup(row.id, row.syncedThrough ?? null)
      const actual = row.providerMonthUsd as number
      const driftUsd = local - actual
      const driftPct = actual > 0 ? (driftUsd / actual) * 100 : null
      const beyond =
        Math.abs(driftUsd) >= toleranceUsd &&
        (driftPct == null || Math.abs(driftPct) >= tolerancePct)
      const status: ReconcileStatus = !beyond ? 'RECONCILED' : driftUsd > 0 ? 'LOCAL_HIGH' : 'LOCAL_LOW'
      return {
        id: row.id,
        label: row.label,
        providerActualUsd: roundUsd(actual),
        localEstimateUsd: roundUsd(local),
        syncedThrough: row.syncedThrough ?? null,
        driftUsd: roundUsd(driftUsd),
        driftPct: driftPct == null ? null : Math.round(driftPct),
        status,
        note:
          status === 'RECONCILED'
            ? 'Local estimate provider বিলের কাছাকাছি ✓'
            : status === 'LOCAL_HIGH'
              ? 'Local estimate আসল বিলের চেয়ে বেশি — cost model বেশি ধরছে।'
              : 'Local estimate আসল বিলের চেয়ে কম — কিছু খরচ under-count হচ্ছে।',
      }
    }

    // Agent-metered but provider gives no authoritative cost → estimate only.
    if (metered && row.monthUsd != null) {
      return {
        id: row.id,
        label: row.label,
        providerActualUsd: null,
        localEstimateUsd: roundUsd(row.monthUsd),
        syncedThrough: null,
        driftUsd: null,
        driftPct: null,
        status: 'UNVERIFIED',
        note: 'Provider cost API নেই — শুধু local estimate, যাচাই করা যায় না।',
      }
    }

    return {
      id: row.id,
      label: row.label,
      providerActualUsd: row.providerMonthUsd != null ? roundUsd(row.providerMonthUsd) : null,
      localEstimateUsd: row.monthUsd != null ? roundUsd(row.monthUsd) : null,
      syncedThrough: row.syncedThrough ?? null,
      driftUsd: null,
      driftPct: null,
      status: 'NO_DATA',
      note: 'কোনো তুলনাযোগ্য সংখ্যা নেই।',
    }
  })

  const reconcilable = providers.filter((p) => p.status === 'RECONCILED' || p.status === 'LOCAL_HIGH' || p.status === 'LOCAL_LOW')
  const totals = reconcilable.reduce(
    (acc, p) => ({
      providerActualUsd: acc.providerActualUsd + (p.providerActualUsd ?? 0),
      localEstimateUsd: acc.localEstimateUsd + (p.localEstimateUsd ?? 0),
      driftUsd: acc.driftUsd + (p.driftUsd ?? 0),
    }),
    { providerActualUsd: 0, localEstimateUsd: 0, driftUsd: 0 },
  )

  const flagged = providers
    .filter((p) => p.status === 'LOCAL_HIGH' || p.status === 'LOCAL_LOW')
    .sort((a, b) => Math.abs(b.driftUsd ?? 0) - Math.abs(a.driftUsd ?? 0))

  return {
    month,
    checkedAt: new Date().toISOString(),
    tolerancePct,
    toleranceUsd,
    totals: {
      providerActualUsd: roundUsd(totals.providerActualUsd),
      localEstimateUsd: roundUsd(totals.localEstimateUsd),
      driftUsd: roundUsd(totals.driftUsd),
    },
    providers,
    flagged,
  }
}

/** Local spend by EFFECTIVE provider for [start, end). */
async function queryLocalSpendByProvider(start: Date, end: Date): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<Array<{ provider: string; total: string }>>(
    Prisma.sql`SELECT ${EFFECTIVE_PROVIDER_SQL} AS provider, COALESCE(SUM(cost_usd), 0)::text AS total
               FROM agent_cost_events
               WHERE occurred_at >= ${start} AND occurred_at < ${end}
               GROUP BY 1`,
  )
  return Object.fromEntries(rows.map((r) => [r.provider, parseFloat(r.total) || 0]))
}
