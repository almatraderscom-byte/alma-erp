#!/usr/bin/env node
/**
 * Smoke test: critical fixes 1–25 structural locks.
 * Run on VPS after deploy: node worker/scripts/verify-critical-fixes.mjs
 */
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { readFileSync, existsSync } from 'fs'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
dotenv.config({ path: join(root, 'worker/.env'), override: true })

const APP_URL = process.env.APP_URL?.replace(/\/$/, '')
const TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''
const OWNER = process.env.TELEGRAM_OWNER_CHAT_ID ?? ''

let passed = 0
let failed = 0

function ok(label) {
  passed++
  console.log(`  ✓ ${label}`)
}

function fail(label, detail = '') {
  failed++
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
}

function assertFileContains(rel, needle, label) {
  const path = join(root, rel)
  if (!existsSync(path)) {
    fail(label, `missing ${rel}`)
    return
  }
  const text = readFileSync(path, 'utf8')
  if (text.includes(needle)) ok(label)
  else fail(label, `expected "${needle}" in ${rel}`)
}

console.log('\n[critical-fixes] structural checks\n')

assertFileContains('worker/src/index.mjs', "import './env-bootstrap.mjs'", '#24 env-bootstrap first import')
assertFileContains('worker/src/telegram/owner-callback-guard.mjs', 'isOwnerOnlyCallback', '#3-6 owner callback guard')
assertFileContains('worker/src/telegram/logged-send.mjs', 'fail closed', '#20 logged-send fail-closed')
assertFileContains('worker/src/index.mjs', 'unknown pending job type', '#21 unknown job handler')
assertFileContains('worker/src/salah/scheduler.mjs', 'salahApiBase()', '#24 salah runtime APP_URL')
assertFileContains('src/app/api/assistant/internal/agent-settings/route.ts', 'isAllowedKey', '#10 settings allowlist')
assertFileContains('src/app/api/assistant/internal/urgent-alert/route.ts', 'PRE_AUTH_TIER3_CATEGORIES', '#22 urgent-alert tier3 gate')
assertFileContains('src/lib/agent-internal-auth.ts', 'actions\\/[^/]+\\/(approve|reject)', '#23 middleware bypass')
assertFileContains('worker/src/twilio-http.mjs', 'verifyTwimlToken', '#12 twiml auth')
assertFileContains('worker/src/twilio-http.mjs', 'verifyTwilioSignature', '#13 call-status signature')
assertFileContains('prisma/migrations/20260718120000_agent_trust_rules/migration.sql', 'agent_trust_rules', '#16 trust rules migration')

async function apiCheck(label, fn) {
  try {
    await fn()
    ok(label)
  } catch (err) {
    fail(label, err.message)
  }
}

if (!APP_URL || !TOKEN) {
  fail('env', 'APP_URL or AGENT_INTERNAL_TOKEN missing')
} else {
  await apiCheck('#24 APP_URL live fetch', async () => {
    const res = await fetch(`${APP_URL}/api/assistant/internal/agent-settings?keys=cs_mode`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  })

  await apiCheck('#10 settings rejects bad key', async () => {
    const res = await fetch(`${APP_URL}/api/assistant/internal/agent-settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ key: 'malicious_key', value: 'x' }),
    })
    if (res.status !== 403) throw new Error(`expected 403 got ${res.status}`)
  })

  await apiCheck('#22 tier3 without preAuth → pending', async () => {
    const res = await fetch(`${APP_URL}/api/assistant/internal/urgent-alert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ tier: 3, title: 'smoke', message: 'test', category: 'smoke_test' }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (!data.pendingApproval) throw new Error('expected pendingApproval')
  })
}

if (OWNER) {
  const { isOwnerChatId } = await import('../src/telegram/owner-id.mjs')
  if (isOwnerChatId(OWNER)) ok('#2 owner chat ID resolves')
  else fail('#2 owner chat ID resolves')
} else {
  fail('#2 owner chat ID', 'TELEGRAM_OWNER_CHAT_ID missing')
}

console.log(`\n[critical-fixes] ${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
