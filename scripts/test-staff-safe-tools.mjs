#!/usr/bin/env node
/**
 * Verifies STAFF_SAFE_TOOLS excludes finance, salah, and personal-memory tools.
 * Run: node scripts/test-staff-safe-tools.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const registry = readFileSync(join(root, 'src/agent/tools/registry.ts'), 'utf8')

const FORBIDDEN = new Set([
  // Personal memory
  'save_memory', 'search_memory', 'update_memory', 'delete_memory',
  // Finance
  'log_expense', 'log_ledger_entry', 'get_expense_summary', 'get_ledger_balances',
  // Salah
  'get_salah_status', 'mark_salah', 'get_salah_weekly_summary', 'set_salah_override',
  // Privileged confirm tools
  'generate_image', 'post_to_facebook',
  // Staff management (owner-only)
  'prepare_staff_task_proposal', 'propose_staff_tasks', 'approve_and_dispatch_tasks', 'add_staff_task_now',
  'update_setting',
  'add_subscription', 'list_subscriptions',
  // Phase 10 owner-only
  'ask_user', 'pause_campaign', 'update_campaign_budget',
  'get_staff_location', 'get_staff_location_history',
])

const namesMatch = registry.match(/export const STAFF_SAFE_TOOL_NAMES\s*=\s*STAFF_SAFE_TOOLS\.map\(\(t\)\s*=>\s*t\.name\)/)
if (!namesMatch) {
  console.error('FAIL: STAFF_SAFE_TOOL_NAMES export missing from registry.ts')
  process.exit(1)
}

const erpSource = readFileSync(join(root, 'src/agent/tools/erp-tools.ts'), 'utf8')
const erpNames = [...erpSource.matchAll(/^\s*name:\s*'([^']+)'/gm)].map((m) => m[1])
const staffNames = ['get_current_datetime', 'list_agent_projects', ...erpNames]

const violations = staffNames.filter((n) => FORBIDDEN.has(n))

if (violations.length > 0) {
  console.error('FAIL: forbidden tools in STAFF_SAFE_TOOLS:', violations.join(', '))
  process.exit(1)
}

console.log(`PASS: STAFF_SAFE_TOOLS has ${staffNames.length} entries, none forbidden (${FORBIDDEN.size} blocked names checked)`)
