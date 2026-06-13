#!/usr/bin/env node
/**
 * Verify progressive summary counts all non-cancelled tasks for task's proposed_for date.
 */
import { createClient } from '@supabase/supabase-js'
import {
  buildProgressiveSummary,
  ensureTaskMarkedDone,
  fetchStaffTasksForDay,
} from '../src/staff/task-progress.mjs'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
  console.log('✅', msg)
}

async function main() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    console.log('SKIP (no supabase env)')
    process.exit(0)
  }

  const s = createClient(url, key)
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const { data: staff } = await s.from('agent_staff').select('id, name').limit(1).maybeSingle()
  if (!staff) {
    console.log('SKIP no staff')
    process.exit(0)
  }

  const ids = []
  for (let i = 0; i < 6; i++) {
    const { data: row } = await s.from('staff_tasks').insert({
      staff_id: staff.id,
      title: `COUNT-TEST ${i + 1}`,
      type: 'office_task',
      status: i < 2 ? 'done' : 'sent',
      proposed_for: today,
      source: 'agent',
      verification_status: i < 2 ? 'owner_approved' : 'not_required',
    }).select('id').single()
    ids.push(row.id)
  }

  const rows = await fetchStaffTasksForDay(s, staff.id, today)
  const testRows = rows.filter((r) => ids.includes(r.id))
  assert(testRows.length === 6, `fetchStaffTasksForDay returns 6 test tasks (got ${testRows.length})`)

  const merged = ensureTaskMarkedDone(testRows, ids[2], 'COUNT-TEST 3')
  const summary = buildProgressiveSummary(staff.name, merged)
  assert(summary.includes('৬'), 'summary shows total ৬')
  assert(summary.includes('৩'), 'summary shows ৩ done after merge')
  assert(!summary.includes('০ সম্পন্ন'), 'summary does not show ০ done')

  await s.from('staff_tasks').delete().in('id', ids)
  console.log('=== approve-count verification PASS ===')
}

main().catch((err) => {
  console.error('❌', err.message)
  process.exit(1)
})
