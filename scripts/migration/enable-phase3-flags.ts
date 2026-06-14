#!/usr/bin/env npx tsx
/**
 * Enable Phase 3: Postgres writes + all read flags.
 * Usage: npx tsx scripts/migration/enable-phase3-flags.ts [true|false]
 */
import { PrismaClient } from '@prisma/client'
import { loadEnvFiles, requireEnv } from './env'
import {
  MIGRATION_WRITES_FROM_SUPABASE,
  migrationFlagKey,
  type MigrationReadDomain,
} from '../../src/lib/migration-flags'

loadEnvFiles()
requireEnv('DATABASE_URL')

const DOMAINS: MigrationReadDomain[] = ['stock', 'products', 'customers', 'promos', 'orders']

async function main() {
  const value = process.argv[2] ?? 'true'
  if (value !== 'true' && value !== 'false') {
    console.log('Usage: enable-phase3-flags.ts [true|false]')
    process.exit(1)
  }
  const prisma = new PrismaClient()
  await prisma.agentKvSetting.upsert({
    where: { key: MIGRATION_WRITES_FROM_SUPABASE },
    create: { key: MIGRATION_WRITES_FROM_SUPABASE, value },
    update: { value },
  })
  console.log(`Set ${MIGRATION_WRITES_FROM_SUPABASE} = ${value}`)
  for (const domain of DOMAINS) {
    const key = migrationFlagKey(domain)
    await prisma.agentKvSetting.upsert({
      where: { key },
      create: { key, value },
      update: { value },
    })
    console.log(`Set ${key} = ${value}`)
  }
  await prisma.$disconnect()
  console.log(value === 'true'
    ? 'Phase 3 enabled — Postgres is source of truth; sheet updates nightly at 03:00 UTC.'
    : 'Phase 3 disabled — reverted to Phase 2 GAS-first writes.')
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
