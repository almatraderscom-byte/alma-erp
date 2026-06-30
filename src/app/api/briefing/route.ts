import { NextRequest } from 'next/server'
import { unstable_cache } from 'next/cache'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'
// The daily tour fans out to several gatherers (orders, inventory, CS, ads);
// give it room on the rare cold computation. Cached results return instantly.
export const maxDuration = 60

import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { apiFailure, apiDataSuccess } from '@/lib/safe-api-response'
import { withApiRoute } from '@/lib/core/safe-route-helpers'
import { buildOwnerDailyDigest } from '@/lib/owner-daily-digest'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

/**
 * GET /api/briefing — owner Morning Briefing for the in-app screen.
 *
 * The whole digest (sales / pending / reorder / CS / staff / decisions + todos,
 * approvals, website + health) is already assembled by `buildOwnerDailyDigest`
 * (src/lib) for the Telegram push. This surfaces the SAME data in the app.
 *
 * Building it tours the ERP, so we wrap it in Next's data cache keyed by the
 * Dhaka business date (revalidated every 30 min) — the first load of a window
 * computes, the rest are instant. `?refresh=1` forces a fresh tour.
 *
 * Owner-facing only (SUPER_ADMIN / ADMIN). Never imports agent code directly —
 * `buildOwnerDailyDigest` lives in src/lib and resolves the agent gatherers at
 * runtime, so the one-way ERP→agent boundary holds.
 */
const getCachedDigest = unstable_cache(
  // The `date` arg is part of the cache key, so a new Dhaka day busts the cache.
  async (_date: string) => buildOwnerDailyDigest(),
  ['owner-briefing-digest'],
  { revalidate: 1800, tags: ['owner-briefing'] },
)

export const GET = withApiRoute('briefing.get', async (req: NextRequest) => {
  const token = await getJwt(req)
  if (!token?.sub) return apiFailure('unauthorized', 'Unauthorized', { status: 401 })
  const role = normalizeAlmaRole(token.role as string)
  if (role !== 'SUPER_ADMIN' && role !== 'ADMIN') {
    return apiFailure('forbidden', 'This briefing is owner-only', { status: 403 })
  }

  const fresh = new URL(req.url).searchParams.get('refresh') === '1'
  const digest = fresh ? await buildOwnerDailyDigest() : await getCachedDigest(todayYmdDhaka())

  // `business` is the OwnerBriefingData (typed `unknown` on the digest); the
  // client renders it structurally. Merge the digest extras alongside it, exactly
  // as the worker-facing internal route does.
  const business = (digest.business as Record<string, unknown> | null) ?? {}

  return apiDataSuccess(
    {
      ...business,
      websiteHealth: digest.websiteHealth,
      pendingApprovalsCount: digest.pendingApprovalsCount,
      openTodos: digest.openTodos,
      lingeringTodos: digest.lingeringTodos,
      healthScan: digest.healthScan,
      cached: !fresh,
    },
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
})
