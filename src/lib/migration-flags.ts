import { prisma } from '@/lib/prisma'

export type MigrationReadDomain = 'orders' | 'stock' | 'products' | 'customers' | 'promos'

const FLAG_PREFIX = 'migration_read_'
const FLAG_SUFFIX = '_from_supabase'

export function migrationFlagKey(domain: MigrationReadDomain): string {
  return `${FLAG_PREFIX}${domain}${FLAG_SUFFIX}`
}

export async function isSupabaseReadEnabled(domain: MigrationReadDomain): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: migrationFlagKey(domain) },
  })
  return row?.value === 'true'
}
