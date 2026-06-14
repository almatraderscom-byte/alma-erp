#!/usr/bin/env npx tsx
/**
 * Toggle migration read flags in agent_kv_settings.
 * Usage: npx tsx scripts/migration/set-migration-flag.ts stock true
 */
import { PrismaClient } from '@prisma/client'
import { loadEnvFiles, requireEnv } from './env'
import { migrationFlagKey, type MigrationReadDomain } from '../../src/lib/migration-flags'

loadEnvFiles()
requireEnv('DATABASE_URL')

const DOMAINS: MigrationReadDomain[] = ['stock', 'products', 'customers', 'promos', 'orders']

async function main() {
  const domain = process.argv[2] as MigrationReadDomain
  const value = process.argv[3]
  if (!domain || !DOMAINS.includes(domain) || !value) {
    console.log('Usage: set-migration-flag.ts <stock|products|customers|promos|orders> <true|false>')
    process.exit(1)
  }
  const prisma = new PrismaClient()
  const key = migrationFlagKey(domain)
  await prisma.agentKvSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
  console.log(`Set ${key} = ${value}`)
  await prisma.$disconnect()
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
