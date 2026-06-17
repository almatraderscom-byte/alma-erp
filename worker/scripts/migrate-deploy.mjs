#!/usr/bin/env node
/**
 * Run Prisma migrations from VPS using worker/.env (safe for multiline values).
 * Usage: node worker/scripts/migrate-deploy.mjs
 */
import dotenv from 'dotenv'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
dotenv.config({ path: join(root, 'worker/.env'), override: true })

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL missing in worker/.env')
  process.exit(1)
}

execSync('npx prisma migrate deploy', { cwd: root, stdio: 'inherit', env: process.env })
