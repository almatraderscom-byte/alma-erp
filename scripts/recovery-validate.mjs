#!/usr/bin/env node
import { createHash } from 'crypto'
import { gunzipSync } from 'zlib'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { spawn } from 'child_process'
import { PrismaClient } from '@prisma/client'

loadEnvFile('.env')
loadEnvFile('.env.local')

const outRoot = resolve(argValue('--out') || 'backups/recovery-validation')
const cleanup = !process.argv.includes('--keep-artifacts')
const productionUrl = process.env.BACKUP_DATABASE_URL || process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
const recoveryUrl = process.env.RECOVERY_DATABASE_URL
const startedAt = Date.now()
let cleanupAttempted = false
const criticalTables = [
  'User',
  'EmployeeLedgerEntry',
  'WalletRequest',
  'AttendanceRecord',
  'AttendanceWaiverRequest',
  'AttendanceSelfieVerification',
  'InvoiceRecord',
  'InvoiceEvent',
  'Notification',
  'NotificationRecipient',
  'NotificationBroadcast',
  'PushSubscription',
  'TradingAccount',
  'TradingTrade',
  'TradingExpense',
  'TradingCapitalEntry',
  'TradingDailySnapshot',
  'TradingBkashDailySummary',
  'TradingPerformanceScreenshot',
  'TradingEmployeeProfile',
  'TradingEmployeeDailyReport',
]

function argValue(name) {
  const raw = process.argv.find(item => item.startsWith(`${name}=`))
  return raw ? raw.slice(name.length + 1) : ''
}

function loadEnvFile(path) {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function log(message) {
  process.stdout.write(`[recovery] ${message}\n`)
}

async function main() {
  if (!productionUrl) throw new Error('BACKUP_DATABASE_URL/DIRECT_DATABASE_URL/DATABASE_URL is required')
  if (!recoveryUrl) throw new Error('RECOVERY_DATABASE_URL is required and must point to an isolated disposable DB')
  assertSafeRecoveryTarget(productionUrl, recoveryUrl)
  mkdirSync(outRoot, { recursive: true })

  await requireTool('pg_dump')
  await requireTool('pg_restore')
  await requireTool('psql')

  log('generating fresh production-safe backup')
  await run('node', ['scripts/backup-production.mjs', '--kind=manual', '--no-upload', `--out=${outRoot}`], { env: { ...process.env, BACKUP_DATABASE_URL: productionUrl } })
  const manifestPath = latestManifest(outRoot)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

  log('verifying backup artifact integrity')
  const integrity = verifyManifest(manifest)
  const fullDump = manifest.files.find(file => file.fileName.endsWith('.dump') && !file.fileName.endsWith('.schema.dump'))
  const schemaDump = manifest.files.find(file => file.fileName.endsWith('.schema.dump'))
  if (!fullDump || !schemaDump) throw new Error('Manifest is missing full or schema dump')
  await run('pg_restore', ['--list', fullDump.path])
  await run('pg_restore', ['--list', schemaDump.path])

  let report
  try {
    log('resetting isolated recovery database')
    await resetRecoveryDatabase()

    log('restoring full backup into isolated recovery database')
    const restoreStart = Date.now()
    await run('pg_restore', ['--no-owner', '--no-acl', '--dbname', recoveryUrl, fullDump.path])
    const restoreMs = Date.now() - restoreStart

    log('validating restored data and indexes')
    const restored = await inspectRestoredDb(recoveryUrl)

    log('running Prisma and application validation against recovery DB')
    await run('npx', ['prisma', 'validate'], { env: { ...process.env, DATABASE_URL: recoveryUrl } })
    await run('npx', ['prisma', 'generate'], { env: { ...process.env, DATABASE_URL: recoveryUrl } })
    await run('npm', ['run', 'type-check'], { env: { ...process.env, DATABASE_URL: recoveryUrl } })
    await run('npm', ['run', 'verify'], { env: { ...process.env, DATABASE_URL: recoveryUrl } })

    report = {
      status: 'RECOVERY-VALIDATED',
      productionTouched: 'read-only pg_dump only',
      recoveryDatabase: safeUrlSummary(recoveryUrl),
      generatedAt: new Date().toISOString(),
      totalMs: Date.now() - startedAt,
      restoreMs,
      manifest: {
        path: manifestPath,
        fileCount: manifest.files.length,
        createdAt: manifest.createdAt,
      },
      integrity,
      restored,
    }
    writeReport(report)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    if (cleanup) await cleanupRecoveryDatabase()
  }
}

function assertSafeRecoveryTarget(prod, recovery) {
  if (prod === recovery) throw new Error('Refusing to restore: production and recovery URLs are identical')
  const prodUrl = parseDbUrl(prod, 'production')
  const recoveryParsed = parseDbUrl(recovery, 'recovery')
  const sameHostAndDb =
    prodUrl.hostname === recoveryParsed.hostname
    && prodUrl.pathname.replace(/^\//, '') === recoveryParsed.pathname.replace(/^\//, '')
  if (sameHostAndDb) throw new Error('Refusing to restore: production and recovery host/database match')

  const host = recoveryParsed.hostname
  const isLocal = ['localhost', '127.0.0.1', '::1'].includes(host)
  if (!isLocal && process.env.ALLOW_EXTERNAL_RECOVERY_DB !== 'true') {
    throw new Error('Refusing non-local recovery DB without ALLOW_EXTERNAL_RECOVERY_DB=true')
  }
  if (/supabase|pooler|aws|render|railway|neon|production|prod/i.test(host) && process.env.ALLOW_EXTERNAL_RECOVERY_DB !== 'true') {
    throw new Error(`Refusing production-like recovery host: ${host}`)
  }
}

function parseDbUrl(value, label) {
  try {
    return new URL(value)
  } catch {
    throw new Error(`Invalid ${label} database URL`)
  }
}

function safeUrlSummary(value) {
  const url = parseDbUrl(value, 'database')
  return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname}`
}

async function resetRecoveryDatabase() {
  cleanupAttempted = true
  await run('psql', [recoveryUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'])
}

async function cleanupRecoveryDatabase() {
  if (!cleanupAttempted) return
  try {
    log('cleaning isolated recovery database schema')
    await run('psql', [recoveryUrl, '-v', 'ON_ERROR_STOP=1', '-c', 'DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;'])
  } catch (error) {
    console.error(`[recovery] cleanup failed: ${error.message}`)
  }
}

function writeReport(report) {
  const reportPath = join(outRoot, `recovery-validation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  log(`validation report: ${reportPath}`)
}

async function requireTool(tool) {
  await run(tool, ['--version'], { inherit: true })
}

function latestManifest(root) {
  const manifests = walk(root).filter(path => path.endsWith('.manifest.json'))
  if (!manifests.length) throw new Error(`No manifest found under ${root}`)
  return manifests.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

function walk(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

function verifyManifest(manifest) {
  const files = []
  for (const file of manifest.files) {
    if (!existsSync(file.path)) throw new Error(`Manifest file missing: ${file.path}`)
    const buffer = readFileSync(file.path)
    const actualSha = createHash('sha256').update(buffer).digest('hex')
    if (actualSha !== file.sha256) throw new Error(`SHA-256 mismatch for ${file.fileName}`)
    if (statSync(file.path).size !== file.sizeBytes) throw new Error(`Size mismatch for ${file.fileName}`)
    if (file.fileName.endsWith('.metadata.json.gz')) {
      JSON.parse(gunzipSync(buffer).toString('utf8'))
    }
    files.push({ fileName: file.fileName, sizeBytes: file.sizeBytes, sha256: actualSha })
  }
  return { ok: true, files }
}

async function inspectRestoredDb(url) {
  const prisma = new PrismaClient({ datasources: { db: { url } } })
  try {
    const tables = await prisma.$queryRawUnsafe(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      criticalTables,
    )
    const indexes = await prisma.$queryRawUnsafe(
      `SELECT tablename, indexname FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename, indexname`,
      criticalTables,
    )
    const constraints = await prisma.$queryRawUnsafe(
      `SELECT tc.table_name, tc.constraint_name, tc.constraint_type FROM information_schema.table_constraints tc WHERE tc.table_schema='public' AND tc.table_name = ANY($1) ORDER BY tc.table_name, tc.constraint_name`,
      criticalTables,
    )
    const rowCounts = {}
    for (const table of criticalTables) {
      if (!tables.some(row => row.table_name === table)) {
        rowCounts[table] = null
        continue
      }
      const rows = await prisma.$queryRawUnsafe(`SELECT COUNT(*)::int AS count FROM "${table}"`)
      rowCounts[table] = rows[0]?.count ?? 0
    }
    const jsonChecks = await validateJsonFields(prisma)
    const smoke = await smokeChecks(prisma)
    const missingTables = criticalTables.filter(table => !tables.some(row => row.table_name === table))
    if (missingTables.length) throw new Error(`Missing critical restored tables: ${missingTables.join(', ')}`)
    return {
      missingTables,
      rowCounts,
      indexCount: indexes.length,
      constraintCount: constraints.length,
      jsonChecks,
      smoke,
    }
  } finally {
    await prisma.$disconnect()
  }
}

async function validateJsonFields(prisma) {
  const checks = []
  for (const item of [
    { table: 'Notification', column: 'metadataJson' },
    { table: 'InvoiceEvent', column: 'metadataJson' },
  ]) {
    const rows = await prisma.$queryRawUnsafe(`SELECT "${item.column}" AS value FROM "${item.table}" WHERE "${item.column}" IS NOT NULL LIMIT 25`)
    let invalid = 0
    for (const row of rows) {
      try { JSON.parse(row.value) } catch { invalid++ }
    }
    checks.push({ ...item, sampled: rows.length, invalid })
  }
  if (checks.some(check => check.invalid > 0)) throw new Error(`Invalid JSON fields detected: ${JSON.stringify(checks)}`)
  return checks
}

async function smokeChecks(prisma) {
  const [
    users,
    wallets,
    attendance,
    notifications,
    tradingAccounts,
    tradingAnalytics,
    invoices,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.employeeLedgerEntry.aggregate({ _sum: { amount: true }, _count: { _all: true } }),
    prisma.attendanceRecord.groupBy({ by: ['businessId'], _count: { _all: true } }).catch(() => []),
    prisma.notification.count(),
    prisma.tradingAccount.count(),
    prisma.tradingDailySnapshot.aggregate({ _sum: { netResultBdt: true }, _count: { _all: true } }),
    prisma.invoiceRecord.count(),
  ])
  return {
    authUsers: users,
    walletLedgerEntries: wallets._count._all,
    walletAmountSum: Number(wallets._sum.amount || 0),
    attendanceBusinessGroups: attendance,
    notifications,
    tradingAccounts,
    tradingSnapshotRows: tradingAnalytics._count._all,
    tradingNetResult: Number(tradingAnalytics._sum.netResultBdt || 0),
    invoices,
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: options.env || process.env,
    })
    let stdout = ''
    let stderr = ''
    if (child.stdout) child.stdout.on('data', chunk => { stdout += String(chunk) })
    if (child.stderr) child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolvePromise(stdout)
      else reject(new Error(`${command} ${args.join(' ')} failed with exit ${code}\n${stderr.slice(0, 2000)}`))
    })
  })
}

main().catch(async error => {
  console.error(`[recovery] failed: ${error.stack || error.message}`)
  const failureReport = {
    status: 'RECOVERY-VALIDATION-FAILED',
    generatedAt: new Date().toISOString(),
    totalMs: Date.now() - startedAt,
    error: error.message,
    productionTouched: 'read-only pg_dump at most',
    recoveryDatabase: recoveryUrl ? safeUrlSummaryOrNull(recoveryUrl) : null,
  }
  mkdirSync(outRoot, { recursive: true })
  writeReport(failureReport)
  await notifyFailure(error).catch(() => {})
  process.exit(1)
})

async function notifyFailure(error) {
  const recipients = String(process.env.BACKUP_ALERT_EMAILS || process.env.SUPER_ADMIN_EMAILS || '').split(',').map(s => s.trim()).filter(Boolean)
  if (!process.env.RESEND_API_KEY || !recipients.length) return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM || 'Alma ERP <onboarding@resend.dev>',
      to: recipients,
      subject: '[CRITICAL] Alma ERP recovery validation failed',
      text: `Recovery validation failed at ${new Date().toISOString()}\n\n${error.stack || error.message}`,
    }),
  })
}

function safeUrlSummaryOrNull(value) {
  try {
    return safeUrlSummary(value)
  } catch {
    return null
  }
}
