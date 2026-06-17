/**
 * Bonus task suggestions when a staff member finishes all daily tasks early.
 * Reuses evening-proposal profile-based rotation logic (3–4 tasks max).
 */
import {
  loadStaffProfiles,
  getProfileForStaff,
  buildTasksForStaff,
} from './evening-proposal.mjs'
import { sendBonusSuggestCard } from '../telegram/dispatcher.mjs'
import { bnNum, formatDhakaTimeBn } from './bn-format.mjs'
import { getAppUrl, getInternalToken } from '../env.mjs'
import { normalizeStaffTaskSource } from './task-source.mjs'

async function callInternal(path) {
  const res = await fetch(`${getAppUrl()}${path}`, {
    headers: { Authorization: `Bearer ${getInternalToken()}` },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    console.warn(`[bonus-suggest] internal call ${path} HTTP ${res.status}`)
  }
  const text = await res.text()
  try { return JSON.parse(text) }
  catch { return { raw: text, ok: res.ok } }
}

const BONUS_TARGET = 4

/** Build 3–4 bonus tasks excluding task types already completed today. */
export function buildBonusTasks(staff, profile, picks, pendingOrders, existingTasks) {
  const usedTypes = new Set(existingTasks.map((t) => t.type).filter(Boolean))

  const candidates = buildTasksForStaff(staff, profile, picks, [], pendingOrders)
  const unique = []
  for (const task of candidates) {
    if (usedTypes.has(task.type)) continue
    if (unique.some((u) => u.type === task.type && u.title === task.title)) continue
    unique.push({ ...task, source: normalizeStaffTaskSource('agent') })
    if (unique.length >= BONUS_TARGET) break
  }
  return unique
}

function formatBonusMessage(staffName, totalDone, tasks) {
  const time = formatDhakaTimeBn()
  const lines = tasks.map((t, i) => `${i + 1}. ${t.title}`).join('\n')
  return (
    `🎉 *${staffName}* সব ${bnNum(totalDone)}টি কাজ শেষ করেছে! (${time})\n\n` +
    `📋 *নতুন কাজের প্রস্তাব:*\n${lines}`
  )
}

export async function suggestBonusTasks({ supabase, telegram, staff, today, existingTasks }) {
  const { data: pendingActions } = await supabase
    .from('agent_pending_actions')
    .select('id, payload')
    .eq('type', 'bonus_task_suggest')
    .eq('status', 'pending')

  const already = (pendingActions ?? []).find((a) => a.payload?.staffId === staff.id && a.payload?.date === today)
  if (already) {
    console.log(`[bonus-suggest] pending card already exists for ${staff.name} on ${today}`)
    return
  }

  const [{ data: staffRow }, profiles, apiData] = await Promise.all([
    supabase.from('agent_staff').select('id, name, role, business_id').eq('id', staff.id).single(),
    loadStaffProfiles(supabase),
    callInternal(`/api/assistant/internal/staff-task-proposal?date=${today}`),
  ])

  const staffMember = staffRow ?? staff
  const profile = getProfileForStaff(profiles, staffMember.name)
  const picks = apiData.rotationPicks ?? []
  const pendingOrders = apiData.pendingOrders ?? 0

  const bonusTasks = buildBonusTasks(staffMember, profile, picks, pendingOrders, existingTasks)
  if (!bonusTasks.length) {
    console.warn(`[bonus-suggest] no bonus tasks generated for ${staffMember.name}`)
    return
  }

  const staffBiz = staffRow?.business_id ?? 'ALMA_LIFESTYLE'

  const taskData = bonusTasks.map((t) => ({
    id: crypto.randomUUID(),
    staff_id: t.staffId,
    title: t.title,
    detail: t.detail ?? null,
    type: t.type,
    product_ref: t.productRef ?? null,
    status: 'proposed',
    proposed_for: today,
    source: normalizeStaffTaskSource('agent'),
    business_id: staffBiz,
    created_at: new Date().toISOString(),
  }))

  const { error: insertErr } = await supabase.from('staff_tasks').insert(taskData)
  if (insertErr) throw new Error(`bonus task insert: ${insertErr.message}`)

  const taskIds = taskData.map((t) => t.id)
  const message = formatBonusMessage(staffMember.name, existingTasks.length, bonusTasks)

  const { data: action, error: actionErr } = await supabase
    .from('agent_pending_actions')
    .insert({
      id: crypto.randomUUID(),
      type: 'bonus_task_suggest',
      payload: { staffId: staffMember.id, staffName: staffMember.name, date: today, taskIds },
      summary: message,
      costEstimate: 0,
      status: 'pending',
      business_id: staffBiz,
      createdAt: new Date().toISOString(),
    })
    .select('id')
    .single()

  if (actionErr) throw new Error(`bonus pending action: ${actionErr.message}`)

  await sendBonusSuggestCard({ message, pendingActionId: action.id })
  console.log(`[bonus-suggest] sent ${bonusTasks.length} bonus tasks for ${staffMember.name}`)
}
