import { logEvent } from '@/lib/logger'
import { isBusinessArchiveSchemaReady } from '@/lib/business-archive/availability'
import { modulesForBusiness, previewModuleArchive } from '@/lib/business-archive/modules'
import type { ArchiveModuleDef } from '@/lib/business-archive/module-registry'

export type ArchiveModuleStat = {
  moduleKey: string
  label: string
  activeCount: number
  archivedCount: number
  available: boolean
  warning?: string | null
}

export function defaultStatsForModules(modules: ArchiveModuleDef[]): ArchiveModuleStat[] {
  return modules.map(m => ({
    moduleKey: m.key,
    label: m.label,
    activeCount: 0,
    archivedCount: 0,
    available: m.key !== 'crm' && m.key !== 'inventory',
    warning: m.integrationNote ?? null,
  }))
}

export async function getArchiveStatsSafe(businessId: string): Promise<{
  stats: ArchiveModuleStat[]
  partialFailure: boolean
}> {
  const mods = modulesForBusiness(businessId)
  const ready = await isBusinessArchiveSchemaReady()
  logEvent('info', 'archive.module.load', { businessId, moduleCount: mods.length, schemaReady: ready })

  if (!ready) {
    logEvent('warn', 'archive.fallback.active', { businessId, reason: 'schema_not_ready' })
    return { stats: defaultStatsForModules(mods), partialFailure: true }
  }

  const { prisma } = await import('@/lib/prisma')
  let partialFailure = false

  const stats = await Promise.all(
    mods.map(async (m): Promise<ArchiveModuleStat> => {
      try {
        const active = await previewModuleArchive(businessId, m.key)
        let archived = 0
        try {
          archived = await prisma.businessArchiveEntity.count({
            where: { businessId, moduleKey: m.key, isArchived: true },
          })
        } catch (err) {
          logEvent('warn', 'archive.registry.warning', {
            businessId,
            moduleKey: m.key,
            message: (err as Error).message,
          })
        }
        return {
          moduleKey: m.key,
          label: m.label,
          activeCount: active.count,
          archivedCount: archived,
          available: true,
          warning: m.integrationNote ?? null,
        }
      } catch (err) {
        partialFailure = true
        logEvent('warn', 'archive.module.failed', {
          businessId,
          moduleKey: m.key,
          message: (err as Error).message,
        })
        return {
          moduleKey: m.key,
          label: m.label,
          activeCount: 0,
          archivedCount: 0,
          available: false,
          warning: m.integrationNote || (err as Error).message || 'Module stats unavailable',
        }
      }
    }),
  )

  return { stats, partialFailure }
}
