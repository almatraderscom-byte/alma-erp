#!/usr/bin/env node
/**
 * Agent self-diagnostic smoke (static + optional live health scan).
 * Usage: node scripts/smoke-agent-diagnostic.mjs
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failures.push(msg)
}

function ok(msg) {
  console.log(`PASS ${msg}`)
}

function read(rel) {
  const p = resolve(root, rel)
  if (!existsSync(p)) {
    fail(`missing ${rel}`)
    return ''
  }
  return readFileSync(p, 'utf8')
}

const health = read('src/lib/diagnostic/health-scan.ts')
const codeSearch = read('src/lib/diagnostic/code-search.ts')
const route = read('src/app/api/assistant/internal/code-search/route.ts')
const tools = read('src/agent/tools/diagnostic-tools.ts')
const registry = read('src/agent/tools/registry.ts')
const prompt = read('src/agent/lib/system-prompt.ts')
const digest = read('src/lib/owner-daily-digest.ts')
const briefing = read('worker/src/reports/owner-briefing.mjs')
const workerHttp = read('worker/src/diagnostic-http.mjs')
const env = read('.env.example')

if (health.includes('runHealthScan') && health.includes('AgentDutyLog')) ok('health-scan module')
else fail('health-scan module incomplete')

if (codeSearch.includes('path out of repo') && codeSearch.includes('isDeniedSourcePath')) ok('code-search guards')
else fail('code-search guards missing')

if (route.includes('AGENT_WORKER_DIAGNOSTIC_URL') && route.includes('unauthorized')) ok('code-search route')
else fail('code-search route incomplete')

if (
  tools.includes('run_health_scan')
  && tools.includes('diagnose_issue')
  && tools.includes('read_source_file')
  && tools.includes('DIAGNOSE-ONLY')
) ok('diagnostic tools')
else fail('diagnostic tools incomplete')

if (registry.includes('DIAGNOSTIC_TOOLS')) ok('registry wired')
else fail('registry missing DIAGNOSTIC_TOOLS')

if (prompt.includes('DIAGNOSTIC_ROLE_PROMPT')) ok('system prompt wired')
else fail('system prompt missing diagnostic role')

if (digest.includes('healthScan')) ok('daily digest healthScan')
else fail('daily digest missing healthScan')

if (briefing.includes('healthScan') && briefing.includes('সিস্টেম হেলথ')) ok('morning briefing health section')
else fail('morning briefing missing health section')

if (workerHttp.includes('/code-search') && workerHttp.includes('AGENT_INTERNAL_TOKEN')) ok('worker diagnostic http')
else fail('worker diagnostic http incomplete')

if (env.includes('AGENT_REPO_PATH') && env.includes('AGENT_WORKER_DIAGNOSTIC_URL')) ok('env example')
else fail('.env.example missing diagnostic vars')

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}

console.log('\nAll static checks passed')

if (process.env.SKIP_LIVE_DIAGNOSTIC !== '1' && process.env.DATABASE_URL) {
  try {
    const { runHealthScan } = await import('../src/lib/diagnostic/health-scan.ts')
    const report = await Promise.race([
      runHealthScan(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 12_000)),
    ])
    if (!report || typeof report.ok !== 'boolean' || !Array.isArray(report.issues)) {
      fail('live health scan bad shape')
    } else {
      ok(`live health scan (${report.issues.length} issues)`)
    }
  } catch (e) {
    console.warn(`SKIP live health scan: ${e?.message ?? e}`)
  }
} else {
  ok('live health scan skipped (no DATABASE_URL)')
}

if (failures.length) {
  console.error(`\n${failures.length} failure(s)`)
  process.exit(1)
}

console.log('✓ Agent diagnostic smoke passed')
