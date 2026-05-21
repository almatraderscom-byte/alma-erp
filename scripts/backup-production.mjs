#!/usr/bin/env node
import { createHash } from 'crypto'
import { createGzip } from 'zlib'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { basename, join, resolve } from 'path'
import { spawn } from 'child_process'

loadEnvFile('.env')
loadEnvFile('.env.local')

const args = new Set(process.argv.slice(2))
const dryRun = args.has('--dry-run')
const noUpload = args.has('--no-upload')
const kind = argValue('--kind') || 'daily'
const outRoot = resolve(argValue('--out') || 'backups')
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const backupName = `alma-erp-${kind}-${timestamp}`
const workDir = join(outRoot, backupName)

const DATABASE_URL = process.env.BACKUP_DATABASE_URL || process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL
const GAS_URL = process.env.BACKUP_GAS_URL || process.env.NEXT_PUBLIC_API_URL
const API_SECRET = process.env.BACKUP_API_SECRET || process.env.API_SECRET

function argValue(name) {
  const raw = process.argv.find(item => item.startsWith(`${name}=`))
  return raw ? raw.slice(name.length + 1) : ''
}

function loadEnvFile(path) {
  if (!existsSync(path)) return
  const text = readFileSync(path, 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf('=')
    if (idx <= 0) continue
    const key = trimmed.slice(0, idx).trim()
    let value = trimmed.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function log(message) {
  process.stdout.write(`[backup] ${message}\n`)
}

function fail(message) {
  throw new Error(message)
}

async function main() {
  if (!['daily', 'weekly', 'monthly', 'manual'].includes(kind)) fail('--kind must be daily, weekly, monthly, or manual')
  if (!DATABASE_URL) fail('DATABASE_URL/BACKUP_DATABASE_URL is required')
  mkdirSync(workDir, { recursive: true })

  const manifest = {
    app: 'alma-erp',
    kind,
    createdAt: new Date().toISOString(),
    format: 'pg_dump custom + gzip metadata',
    files: [],
    envChecklist: envChecklist(),
  }

  if (dryRun) {
    log('dry run: validating backup configuration only')
    await commandVersion('pg_dump')
    writeFileSync(join(workDir, 'DRY_RUN_OK.txt'), 'Backup dry run completed.\n')
    log(`dry run output: ${workDir}`)
    return
  }

  await commandVersion('pg_dump')
  await runPgDump(join(workDir, `${backupName}.dump`), [])
  await runPgDump(join(workDir, `${backupName}.schema.dump`), ['--schema-only'])
  await writeMetadata(join(workDir, `${backupName}.metadata.json.gz`))

  for (const file of [
    join(workDir, `${backupName}.dump`),
    join(workDir, `${backupName}.schema.dump`),
    join(workDir, `${backupName}.metadata.json.gz`),
  ]) {
    manifest.files.push(fileInfo(file))
  }
  const manifestPath = join(workDir, `${backupName}.manifest.json`)
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  manifest.files.push(fileInfo(manifestPath))

  if (!noUpload) {
    if (!GAS_URL || !API_SECRET) fail('BACKUP_GAS_URL/NEXT_PUBLIC_API_URL and BACKUP_API_SECRET/API_SECRET are required for Drive upload')
    for (const file of [manifestPath, ...manifest.files.filter(f => f.path !== manifestPath).map(f => f.path)]) {
      await uploadToDrive(file, kind)
    }
    await runDriveRetention()
  }

  log(`backup completed: ${workDir}`)
}

async function commandVersion(bin) {
  await run(bin, ['--version'], { inherit: true })
}

async function runPgDump(outputFile, extraArgs) {
  log(`creating ${basename(outputFile)}`)
  await run('pg_dump', [
    DATABASE_URL,
    '--format=custom',
    '--compress=9',
    '--no-owner',
    '--no-acl',
    ...extraArgs,
    '--file',
    outputFile,
  ])
}

async function writeMetadata(outputFile) {
  log(`creating ${basename(outputFile)}`)
  const metadata = {
    createdAt: new Date().toISOString(),
    nodeEnv: process.env.NODE_ENV || null,
    requiredEnvPresent: envChecklist(),
    restoreNotes: [
      'Restore full backup with pg_restore into a clean database after running compatibility checks.',
      'Run prisma migrate status before reconnecting production traffic.',
      'Never restore directly over production without a fresh pre-restore backup.',
    ],
  }
  await gzipJson(outputFile, metadata)
}

function gzipJson(outputFile, payload) {
  return new Promise((resolvePromise, reject) => {
    const gzip = createGzip({ level: 9 })
    const out = createWriteStream(outputFile)
    gzip.on('error', reject)
    out.on('error', reject)
    out.on('finish', resolvePromise)
    gzip.end(JSON.stringify(payload, null, 2))
    gzip.pipe(out)
  })
}

function fileInfo(path) {
  const buffer = readFileSync(path)
  return {
    path,
    fileName: basename(path),
    sizeBytes: statSync(path).size,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

async function uploadToDrive(path, backupKind) {
  const info = fileInfo(path)
  log(`uploading ${info.fileName} (${Math.round(info.sizeBytes / 1024)} KB)`)
  const data = readFileSync(path).toString('base64')
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route: 'backup_upload',
      secret: API_SECRET,
      kind: backupKind,
      file_name: info.fileName,
      mime_type: info.fileName.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      sha256: info.sha256,
      size_bytes: info.sizeBytes,
      data,
    }),
  })
  const text = await res.text()
  let json = {}
  try { json = JSON.parse(text) } catch {}
  if (!res.ok || json.error || json.ok === false) {
    throw new Error(`Drive upload failed for ${info.fileName}: ${json.error || text.slice(0, 240)}`)
  }
}

async function runDriveRetention() {
  log('running Drive retention cleanup')
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      route: 'backup_retention_cleanup',
      secret: API_SECRET,
      daily_days: Number(process.env.BACKUP_DAILY_RETENTION_DAYS || 14),
      weekly_days: Number(process.env.BACKUP_WEEKLY_RETENTION_DAYS || 56),
      monthly_days: Number(process.env.BACKUP_MONTHLY_RETENTION_DAYS || 395),
    }),
  })
  const text = await res.text()
  let json = {}
  try { json = JSON.parse(text) } catch {}
  if (!res.ok || json.error || json.ok === false) {
    throw new Error(`Drive retention cleanup failed: ${json.error || text.slice(0, 240)}`)
  }
}

function envChecklist() {
  const keys = [
    'DATABASE_URL',
    'DIRECT_DATABASE_URL',
    'NEXTAUTH_SECRET',
    'API_SECRET',
    'NEXT_PUBLIC_API_URL',
    'RESEND_API_KEY',
    'ONESIGNAL_APP_ID',
    'ONESIGNAL_REST_API_KEY',
    'TRADING_SCREENSHOT_CLEANUP_SECRET',
    'CRON_SECRET',
  ]
  return Object.fromEntries(keys.map(key => [key, Boolean(process.env[key])]))
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: options.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    })
    let stderr = ''
    if (child.stderr) child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} failed with exit ${code}: ${stderr.slice(0, 1000)}`))
    })
  })
}

main().catch(async error => {
  console.error(`[backup] failed: ${error.message}`)
  await notifyFailure(error).catch(() => {})
  if (existsSync(workDir) && args.has('--cleanup-on-fail')) await rm(workDir, { recursive: true, force: true })
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
      subject: '[CRITICAL] Alma ERP backup failed',
      text: `Backup failed at ${new Date().toISOString()}\n\n${error.stack || error.message}`,
    }),
  })
}
