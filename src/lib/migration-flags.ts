import { prisma } from '@/lib/prisma'

export type MigrationReadDomain = 'orders' | 'stock' | 'products' | 'customers' | 'promos'

const FLAG_PREFIX = 'migration_read_'
const FLAG_SUFFIX = '_from_supabase'
export const MIGRATION_WRITES_FROM_SUPABASE = 'migration_writes_from_supabase'

export function migrationFlagKey(domain: MigrationReadDomain): string {
  return `${FLAG_PREFIX}${domain}${FLAG_SUFFIX}`
}

export async function isSupabaseReadEnabled(domain: MigrationReadDomain): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: migrationFlagKey(domain) },
  })
  return row?.value === 'true'
}

export async function isSupabaseWriteEnabled(): Promise<boolean> {
  const row = await prisma.agentKvSetting.findUnique({
    where: { key: MIGRATION_WRITES_FROM_SUPABASE },
  })
  return row?.value === 'true'
}

/** Phase 3: writes on → always read Postgres. Phase 2: per-domain read flag. */
export async function usePostgresFor(domain: MigrationReadDomain): Promise<boolean> {
  if (await isSupabaseWriteEnabled()) return true
  return isSupabaseReadEnabled(domain)
}
