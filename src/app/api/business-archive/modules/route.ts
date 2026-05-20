import { NextRequest, NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { normalizeAlmaRole } from '@/lib/roles'
import { logEvent } from '@/lib/logger'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'
import {
  defaultStatsForModules,
  getArchiveStatsSafe,
} from '@/lib/business-archive/safe'
import { modulesForBusiness } from '@/lib/business-archive/module-registry'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const token = await getJwt(req)
  if (!token?.sub) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (normalizeAlmaRole(token.role as string) !== 'SUPER_ADMIN') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

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

    return NextResponse.json({
      ok: true,
      businessId,
      modules,
      stats,
      schemaReady,
      partialFailure,
      warning,
      migrationHint: schemaReady ? null : 'Run npm run db:migrate:deploy on production',
    })
  } catch (err) {
    const message = (err as Error).message || 'Archive modules unavailable'
    logEvent('error', 'archive.module.failed', { businessId, message })
    return NextResponse.json({
      ok: false,
      businessId,
      modules,
      stats: defaultStatsForModules(modules),
      schemaReady: false,
      partialFailure: true,
      warning: message,
      error: message,
    })
  }
}
