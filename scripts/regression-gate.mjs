#!/usr/bin/env node
/**
 * Full pre-deploy gate: typecheck → build → regression smoke.
 * Exit 1 blocks deploy.
 */
import { spawnSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadRegressionEnvFiles } from './regression-env.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
loadRegressionEnvFiles()

if (!process.env.REGRESSION_BASE_URL) {
  process.env.REGRESSION_BASE_URL = 'https://alma-erp-six.vercel.app'
}

function run(cmd, args) {
  console.log(`\n▶ ${cmd} ${args.join(' ')}`)
  const r = spawnSync(cmd, args, { cwd: root, stdio: 'inherit', env: process.env })
  if (r.status !== 0) process.exit(r.status ?? 1)
}

console.log('Alma ERP — regression deployment gate')

if (process.env.DATABASE_URL) {
  run('node', ['scripts/check-pending-migrations.mjs'])
} else {
  console.log('\n⚠ DATABASE_URL not set — skipping pending migration check (set in CI/production)')
}

run('npm', ['run', 'type-check'])
run('npm', ['run', 'build'])

const requireAuth = process.env.REQUIRE_REGRESSION_AUTH === '1'
const hasAuth =
  process.env.REGRESSION_COOKIE ||
  ((process.env.REGRESSION_IDENTIFIER || process.env.REGRESSION_EMAIL) &&
    process.env.REGRESSION_PASSWORD)

if (requireAuth && !hasAuth) {
  console.error(
    '\n[FAIL] REQUIRE_REGRESSION_AUTH=1 but no REGRESSION_COOKIE or REGRESSION_IDENTIFIER+REGRESSION_PASSWORD',
  )
  process.exit(1)
}

const smokeEnv = {
  ...process.env,
  ...(requireAuth ? { REQUIRE_REGRESSION_AUTH: '1', CI: 'true' } : {}),
}
const smoke = spawnSync('node', ['scripts/regression-smoke.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: smokeEnv,
})
if (smoke.status !== 0) process.exit(smoke.status ?? 1)

const attendanceSmoke = spawnSync('node', ['scripts/attendance-regression-smoke.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: smokeEnv,
})
if (attendanceSmoke.status !== 0) process.exit(attendanceSmoke.status ?? 1)

const mobileSmoke = spawnSync('node', ['scripts/mobile-runtime-regression-smoke.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: smokeEnv,
})
if (mobileSmoke.status !== 0) process.exit(mobileSmoke.status ?? 1)

const attendanceWidgetSmoke = spawnSync('node', ['scripts/attendance-widget-regression-smoke.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: smokeEnv,
})
if (attendanceWidgetSmoke.status !== 0) process.exit(attendanceWidgetSmoke.status ?? 1)

const photoTelegramSmoke = spawnSync('node', ['scripts/attendance-photo-telegram-smoke.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: smokeEnv,
})
if (photoTelegramSmoke.status !== 0) process.exit(photoTelegramSmoke.status ?? 1)

const prodVerify = spawnSync('node', ['scripts/attendance-production-verify.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: smokeEnv,
})
if (prodVerify.status !== 0) process.exit(prodVerify.status ?? 1)

console.log('\n✓ Regression gate passed')
