#!/usr/bin/env node
/**
 * Unit-style check for urgent alert rate-limit logic (no real notify/call).
 * Run: node scripts/test-reminder-rate-limit.mjs
 */
import { readFileSync } from 'fs'

const src = readFileSync('src/agent/lib/urgent-rate-limit.ts', 'utf8')

const checks = [
  { name: 'tier 2 limit 5/hour', ok: /tier === 2 \? 5 : TIER3_URGENT_LIMIT/.test(src) },
  { name: 'tier 3 limit 5/24h', ok: /TIER3_URGENT_LIMIT = 5/.test(src) },
  { name: 'tier 3 excludes salah', ok: /NOT: \{ category: 'salah' \}/.test(src) },
  { name: 'outbound call limit 10/24h', ok: /OUTBOUND_CALL_LIMIT = 10/.test(src) },
  { name: 'uses agentNotification count', ok: /agentNotification\.count/.test(src) },
]

let failed = 0
for (const c of checks) {
  console.log(c.ok ? `✅ ${c.name}` : `❌ ${c.name}`)
  if (!c.ok) failed++
}

const migration = readFileSync(
  'prisma/migrations/20260612120000_agent_phase9_reminders/migration.sql',
  'utf8',
)
const badIndexExprs = migration.match(/CREATE INDEX.*\(/gi)?.filter((line) => /::/.test(line)) ?? []
if (badIndexExprs.length) {
  console.log('❌ migration has :: in index expressions')
  failed++
} else {
  console.log('✅ migration indexes plain columns only')
}

process.exit(failed ? 1 : 0)
