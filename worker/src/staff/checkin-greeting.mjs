/**
 * Check-in greeting + task follow-up trigger.
 *
 * Owner requirement: the moment a staff member checks in, the agent must FIRST
 * greet them, THEN start following up on that day's tasks. Previously nothing
 * fired on check-in because the attendance gate (getCheckedInMap) was querying a
 * non-existent table — see attendance.mjs. With the gate fixed, this job is the
 * piece that actually reacts to a check-in.
 *
 * Behaviour (runs every few minutes during office hours):
 *   1. Find staff who have tasks today AND have checked in (AttendanceRecord).
 *   2. For each one not yet greeted today, send ONE warm Islamic greeting that
 *      also carries their task list — greeting first, follow-up in the same breath.
 *   3. Idempotent: a staff member is greeted at most once per Dhaka day. The
 *      agent_outbox row (type='checkin_greeting') is the durable dedupe record,
 *      so a worker restart / re-run never double-greets.
 *
 * This is outbound-only and goes through the normal staff-approval + office-hours
 * gates via loggedSendToStaff. Fails safe: any per-staff error is logged, never
 * throws out of the scheduler.
 */

import { loggedSendToStaff } from '../telegram/logged-send.mjs'
import { getCheckedInMap, dhakaToday } from './attendance.mjs'
import { isWithinOfficeHours } from './office-hours.mjs'
import { isStaffOnLeaveSb } from './leave.mjs'
import { progressButtonRow } from './progress-button.mjs'
import { isStaffTaskEnabled } from './staff-toggle.mjs'
import { lunchButtonRow } from './lunch.mjs'
import { leaveRequestButton } from './leave.mjs'

const GREETING_TYPE = 'checkin_greeting'

/** UTC ISO instant of the start of today's Dhaka calendar day (for an outbox lower bound). */
function dhakaDayStartIso(today = dhakaToday()) {
  return new Date(`${today}T00:00:00+06:00`).toISOString()
}

function firstName(name) {
  return String(name || 'ভাই').trim().split(/\s+/)[0] || 'ভাই'
}

/**
 * @param {{ supabase: import('@supabase/supabase-js').SupabaseClient, bot: any }} ctx
 */
export async function runCheckinGreeting({ supabase, bot }) {
  if (!bot) return { dutyStatus: 'skipped', dutyDetail: 'bot নেই' }
  if (!isWithinOfficeHours('ALMA_LIFESTYLE')) {
    return { dutyStatus: 'skipped', dutyDetail: 'অফিস সময়ের বাইরে' }
  }

  const today = dhakaToday()

  // Staff with tasks today — the people we actually have follow-up for.
  const { data: tasks, error: taskErr } = await supabase
    .from('staff_tasks')
    .select('id, title, status, type, staff_id, agent_staff(id, name, telegramChatId, user_id)')
    .eq('proposed_for', today)
    .in('status', ['sent', 'done', 'done_unverified', 'verified'])

  if (taskErr) {
    console.error('[checkin-greeting] task query failed:', taskErr.message)
    return { dutyStatus: 'skipped', dutyDetail: `DB error: ${taskErr.message}` }
  }
  if (!tasks?.length) {
    return { dutyStatus: 'done', dutyDetail: 'আজ কোনো টাস্ক নেই' }
  }

  // Group active tasks by staff (skip learning items — not staff-facing work).
  const byStaff = {}
  for (const t of tasks) {
    if (t.type === 'learning') continue
    const s = t.agent_staff
    if (!s?.id || !s.telegramChatId) continue
    byStaff[s.id] ??= { staff: s, tasks: [] }
    byStaff[s.id].tasks.push(t)
  }

  const entries = Object.values(byStaff)
  if (!entries.length) return { dutyStatus: 'done', dutyDetail: 'যোগ্য স্টাফ নেই' }

  // Only greet staff who have actually checked in today.
  const checkedIn = await getCheckedInMap(supabase, entries.map((e) => e.staff))
  const checkedInEntries = entries.filter(({ staff }) => checkedIn.has(staff.id))
  if (!checkedInEntries.length) {
    return { dutyStatus: 'done', dutyDetail: 'কেউ এখনো চেক-ইন করেনি' }
  }

  // Durable dedupe: who has already been greeted today?
  // A greeting is sent at most ONCE per staff per day. Two durable records can
  // prove it happened, and we must honour BOTH — otherwise we re-greet forever:
  //   1. agent_outbox — written only when the message actually goes out (i.e. the
  //      approval was auto/owner-approved). status queued|delivered.
  //   2. agent_pending_actions — written when the message needs owner approval and
  //      is waiting. The outbox row only appears AFTER approval, so if we ignored
  //      this table a pending (or owner-rejected) greeting would never count as
  //      "done" and the job would resend a fresh approval card every tick.
  // We treat a greeting as handled regardless of the pending action's outcome
  // (pending / approved / rejected): if the owner said "বাতিল", that's a decision
  // for today — don't nag again.
  const sinceIso = dhakaDayStartIso(today)
  const [{ data: priorGreets }, { data: priorPending }] = await Promise.all([
    supabase
      .from('agent_outbox')
      .select('staff_id, status')
      .eq('type', GREETING_TYPE)
      .in('status', ['queued', 'delivered'])
      .gte('created_at', sinceIso),
    supabase
      .from('agent_pending_actions')
      .select('payload')
      .eq('type', 'staff_auto_message')
      .gte('createdAt', sinceIso), // NOTE: this table uses camelCase createdAt (agent_outbox uses created_at)
  ])

  const alreadyGreeted = new Set((priorGreets ?? []).map((r) => r.staff_id).filter(Boolean))
  for (const row of priorPending ?? []) {
    const p = row?.payload
    if (p && p.type === GREETING_TYPE && p.staffId) alreadyGreeted.add(p.staffId)
  }
  const showProgress = await isStaffTaskEnabled(supabase, 'progress_ask')

  let greeted = 0
  let skippedGreeted = 0

  for (const { staff, tasks: staffTasks } of checkedInEntries) {
    if (alreadyGreeted.has(staff.id)) {
      skippedGreeted += 1
      continue
    }
    if (await isStaffOnLeaveSb(supabase, staff.id, today)) continue

    const name = firstName(staff.name)
    const taskList = staffTasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
    const msg =
      `আসসালামু আলাইকুম ${name} ভাই! 🤝\n` +
      `চেক-ইন করার জন্য ধন্যবাদ — আজকের দিনটা ভালো কাটুক।\n\n` +
      `📋 *আজকের কাজ:*\n${taskList}\n\n` +
      `একটা একটা করে শুরু করুন, শেষ হলে ✅ Done বাটন চাপুন। সারাদিন সাথে আছি।`

    const keyboard = [
      [{ text: '💬 Feedback দিন', callback_data: `staff_feedback_open:${staff.id}` }],
      lunchButtonRow(),
      [leaveRequestButton()],
    ]
    if (showProgress) keyboard.unshift(progressButtonRow())

    const res = await loggedSendToStaff(bot.telegram, {
      supabase,
      staffId: staff.id,
      staffName: staff.name,
      businessId: 'ALMA_LIFESTYLE',
      type: GREETING_TYPE,
      content: msg,
      chatId: staff.telegramChatId,
      relatedTaskIds: staffTasks.map((t) => t.id),
      officeHoursOnly: true,
      extra: { reply_markup: { inline_keyboard: keyboard } },
    }).catch((err) => {
      console.warn(`[checkin-greeting] send failed for ${staff.name}:`, err.message)
      return { ok: false }
    })

    // Count it as greeted whenever a durable outbox row was created (delivered OR
    // queued for approval) — that row is what stops a re-greet next tick.
    if (res?.ok || res?.outboxId || res?.queued) {
      greeted += 1
      alreadyGreeted.add(staff.id)
    }
  }

  console.log(`[checkin-greeting] greeted ${greeted} staff (${skippedGreeted} already greeted today)`)
  return {
    dutyStatus: 'done',
    dutyDetail: `${greeted} জনকে চেক-ইন গ্রিটিং, ${skippedGreeted} জন আগেই হয়েছে`,
  }
}
