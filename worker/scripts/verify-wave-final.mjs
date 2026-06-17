#!/usr/bin/env node
/**
 * Smoke test — Final hardening wave (Vercel-side bugs)
 * SSRF, timeouts, silent catches, unguarded sends
 */
import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..', '..')
let pass = 0, fail = 0

function assertFile(relPath, predicate, label) {
  try {
    const text = readFileSync(resolve(root, relPath), 'utf8')
    if (predicate(text)) { pass++; console.log(`  ✅ ${label}`) }
    else { fail++; console.error(`  ❌ ${label}`) }
  } catch (err) { fail++; console.error(`  ❌ ${label} — file read error: ${err.message}`) }
}

console.log('\n🔒 Final Wave — Vercel-side Hardening\n')

// ── SSRF fixes ──
console.log('▸ SSRF Protection')
assertFile('src/app/api/assistant/internal/assess-task-proof/route.ts',
  t => t.includes('isTrustedImageUrl') && t.includes('TRUSTED_IMAGE_HOSTS') && t.includes('fetchImageSafe'),
  'assess-task-proof: SSRF protection with trusted host allowlist')

assertFile('src/app/api/assistant/internal/assess-task-proof/route.ts',
  t => t.includes('MAX_IMAGE_BYTES') && t.includes('cachedImage'),
  'assess-task-proof: image size limit + cached image reuse')

assertFile('src/app/api/assistant/internal/assess-task-proof/route.ts',
  t => t.includes("assessment_error") && !t.includes("assessment_failed"),
  'assess-task-proof: fail-closed on error (not fail-open)')

assertFile('src/agent/lib/cs/post-products.ts',
  t => t.includes('isTrustedImageHost') && t.includes('rejected untrusted image URL'),
  'post-products: SSRF protection with trusted host check')

// ── Fetch timeouts ──
console.log('\n▸ Fetch Timeouts')
assertFile('src/agent/lib/owner-briefing-data.ts',
  t => /AbortSignal\.timeout\(20_000\)/.test(t) && /AbortSignal\.timeout\(15_000\)/.test(t),
  'owner-briefing-data: Meta API fetches have timeouts')

assertFile('src/lib/financial-intelligence.ts',
  t => /AbortSignal\.timeout\(20_000\)/.test(t) && /AbortSignal\.timeout\(15_000\)/.test(t),
  'financial-intelligence: Meta API fetches have timeouts')

assertFile('src/agent/lib/api-balances.ts',
  t => (t.match(/AbortSignal\.timeout/g) || []).length >= 4,
  'api-balances: Twilio/Anthropic/OpenAI/ElevenLabs fetches have timeouts')

assertFile('src/agent/tools/cs-tools.ts',
  t => (t.match(/AbortSignal\.timeout/g) || []).length >= 4,
  'cs-tools: image + Telegram fetches have timeouts')

assertFile('src/agent/lib/meta.ts',
  t => /getRecentPosts[\s\S]{0,500}AbortSignal\.timeout/.test(t),
  'meta.ts: getRecentPosts has timeout')

assertFile('src/lib/weekly-strategic-data.ts',
  t => /AbortSignal\.timeout\(15_000\)/.test(t),
  'weekly-strategic-data: Meta insights fetch has timeout')

assertFile('src/agent/lib/cs/post-products.ts',
  t => /AbortSignal\.timeout\(15_000\)/.test(t) && /AbortSignal\.timeout\(10_000\)/.test(t),
  'post-products: image + Telegram fetches have timeouts')

// ── Silent catch fixes ──
console.log('\n▸ Silent Catch Fixes')
assertFile('src/agent/lib/owner-briefing-data.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'owner-briefing-data: no silent catches remaining')

assertFile('src/agent/lib/business-brain.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'business-brain: no silent catches remaining')

assertFile('src/lib/diagnostic/health-scan.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'health-scan: no silent catches remaining')

assertFile('src/lib/owner-daily-digest.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'owner-daily-digest: no silent catches remaining')

assertFile('src/agent/lib/api-balances.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'api-balances: no silent catches remaining')

assertFile('src/agent/lib/intelligence/counter-propose.ts',
  t => !t.includes('catch { /* non-fatal */'),
  'counter-propose: catches have logging')

assertFile('src/agent/lib/intelligence/staff-comms.ts',
  t => !t.includes('catch { /* fallback') && !t.includes('catch { /* non-fatal'),
  'staff-comms: catches have logging')

assertFile('src/agent/lib/intelligence/staff-capability.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'staff-capability: no silent catches remaining')

assertFile('src/agent/lib/intelligence/task-intelligence.ts',
  t => {
    const catches = t.match(/catch\s*\{/g)
    return !catches || catches.length === 0
  },
  'task-intelligence: no silent catches remaining')

assertFile('src/agent/lib/core.ts',
  t => t.includes('[core] loadPinnedMemories') && t.includes('[core] loadOwnerDecisions'),
  'core.ts: memory loading catches have logging')

assertFile('src/agent/lib/models/run-owner-turn.ts',
  t => t.includes('[run-owner-turn] loadPinnedMemories') && t.includes('[run-owner-turn] loadOwnerDecisions'),
  'run-owner-turn: memory loading catches have logging')

assertFile('src/agent/lib/agent-memory.ts',
  t => t.includes('[agent-memory] reinforceMemoriesOnUse') && t.includes('[agent-memory] retrieveRelevantMemories'),
  'agent-memory: catches have logging')

assertFile('src/lib/outcome-metrics.ts',
  t => t.includes('[outcome-metrics] fetchRecentOrders') && t.includes('[outcome-metrics] getSalesTotal7d'),
  'outcome-metrics: catches have logging')

assertFile('src/lib/strategist-run.ts',
  t => t.includes('[strategist] parseStrategistResponse'),
  'strategist-run: parse catch has logging')

assertFile('src/lib/reflection-run.ts',
  t => t.includes('[reflection] parseReflectionResponse'),
  'reflection-run: parse catch has logging')

assertFile('src/lib/weekly-strategic-data.ts',
  t => t.includes('[weekly-strategic] fetchGasOrders') && t.includes('[weekly-strategic] getWeekAdSpend'),
  'weekly-strategic-data: catches have logging')

// ── Env var caching fixes ──
console.log('\n▸ Env Var Caching Fixes')
assertFile('src/agent/lib/meta.ts',
  t => t.includes('function getPageToken(pageId') && !t.includes("PAGE_TOKENS: Record"),
  'meta.ts: FB page tokens loaded at runtime, not module load')

// ── Telegram send safety ──
console.log('\n▸ Telegram Send Safety')
assertFile('src/agent/tools/cs-tools.ts',
  t => t.includes('[cs-tools] owner draft notify failed') && t.includes('[cs-tools] eyafi draft notify failed'),
  'cs-tools: Telegram sends have error logging')

assertFile('src/agent/tools/cs-tools.ts',
  t => t.includes('[cs-tools] eyafi handoff notify failed'),
  'cs-tools: handoff Telegram send has error logging')

// ── Summary ──
console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`)
console.log(`  Final Wave: ${pass} passed, ${fail} failed`)
console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`)
process.exit(fail > 0 ? 1 : 0)
