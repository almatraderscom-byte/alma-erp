import { NextRequest } from 'next/server'
import { logEvent } from '@/lib/logger'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'
import { defaultStatsForModules, getArchiveStatsSafe } from '@/lib/business-archive/safe'
import { modulesForBusiness } from '@/lib/business-archive/module-registry'
import { withApiRoute, apiDataSuccess, requireJwtRoles } from '@/lib/core/safe-route-helpers'

export const dynamic = 'force-dynamic'

export const GET = withApiRoute('archive.modules', async (req: NextRequest) => {
  const auth = await requireJwtRoles(req, ['SUPER_ADMIN'])
  if (!auth.ok) return auth.response

  const businessId = new URL(req.url).searchParams.get('business_id') || 'ALMA_LIFESTYLE'
  const modules = modulesForBusiness(businessId)

  try {
    const schemaReady = await isBusinessArchiveSchemaReady()
    let stats = defaultStatsForModules(modules)
    let partialFailure = !schemaReady
    let warning: string | null = schemaReady
      ? null
      : 'Archive schema not detected — showing module list only. Run db:migrate:deploy if needed.'

    if (schemaReady) {
      try {
        const loaded = await getArchiveStatsSafe(businessId)
        stats = loaded.stats
        partialFailure = loaded.partialFailure
        if (partialFailure) {
          warning = 'Some module stats could not be loaded. You can still preview/archive supported modules.'
        }
      } catch (err) {
        partialFailure = true
        warning = (err as Error).message || 'Stats unavailable'
        logEvent('warn', 'archive.module.failed', { businessId, scope: 'modules_route', message: warning })
      }
    }

    logEvent('info', 'archive.module.load', {
      businessId,
      schemaReady,
      moduleCount: modules.length,
      partialFailure,
    })

    return apiDataSuccess({
      businessId,
      modules,
      stats,
      schemaReady,
      partialFailure,
      warning,
    })
  } catch (err) {
    logEvent('error', 'archive.module.failed', {
      businessId,
      message: (err as Error).message,
    })
    return apiDataSuccess({
      businessId,
      modules,
      stats: defaultStatsForModules(modules),
      schemaReady: false,
      partialFailure: true,
      warning: (err as Error).message || 'Failed to load modules',
    })
  }
})
