#!/usr/bin/env node
/**
 * One-off: dismiss pending shadow drafts + skip pending reply jobs from inbox poll backfill.
 * Run from repo root: node worker/scripts/cancel-cs-backfill.mjs
 */
import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const envPath = resolve(root, 'worker/.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/)
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '')
  }
}

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error('DATABASE_URL missing (set in worker/.env)')
  process.exit(1)
}

const sql = `
UPDATE cs_shadow_drafts SET status='dismissed', escalation_stage='none' WHERE status='pending';
UPDATE cs_reply_jobs SET status='skipped', last_error='backfill_cancelled' WHERE status='pending';
`
execSync(`psql "${dbUrl}" -c "${sql.replace(/\n/g, ' ')}"`, { stdio: 'inherit', cwd: root })
console.log('Backfill cleanup done')
