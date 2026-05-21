#!/usr/bin/env node
/**
 * Fails if Prisma reports unapplied migrations (blocks production deploy).
 */
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const r = spawnSync('npx', ['prisma', 'migrate', 'status'], {
  cwd: root,
  encoding: 'utf8',
  env: process.env,
})

const out = `${r.stdout || ''}${r.stderr || ''}`
process.stdout.write(out)

if (r.status !== 0) {
  console.error('\n[FAIL] prisma migrate status failed — check DATABASE_URL and connectivity')
  process.exit(1)
}

if (/have not yet been applied/i.test(out) || /following migration/i.test(out) && !/Database schema is up to date/i.test(out)) {
  console.error('\n[FAIL] Pending Prisma migrations — run: npm run db:migrate:deploy')
  process.exit(1)
}

if (!/Database schema is up to date/i.test(out)) {
  console.error('\n[FAIL] Migration state unclear — resolve failed migrations before deploy')
  process.exit(1)
}

console.log('\n✓ No pending migrations')
