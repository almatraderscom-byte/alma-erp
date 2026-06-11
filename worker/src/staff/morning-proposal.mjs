/**
 * Morning Proposal Job — runs at 09:00 Asia/Dhaka
 * 1. Gather: yesterday's sales/orders, inventory, carry-forward candidates, rotation picks
 * 2. Build per-staff Bangla task list (Eyafi: content/orders, Mustahid: stock/COD/misc)
 * 3. Save as 'proposed' via agent API
 * 4. Send ONE Telegram approval card to owner
 */

import { getRotationPicks } from './rotation.mjs'

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

async function callInternal(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN}`,
    },
  }
  if (body) opts.body = JSON.stringify(body)
  const res = await fetch(`${APP_URL}${path}`, opts)
  const text = await res.text()
  try { return JSON.parse(text) }
  catch { return { raw: text } }
}

function dhakaDateStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

// ── Carry-forward: find incomplete tasks from yesterday ────────────────────

async function getCarryForwardTasks(supabase) {
  const yesterday = dhakaDateStr(-1)
  const { data: tasks } = await supabase
    .from('staff_tasks')
    .select('*, agent_staff(id, name)')
    .eq('proposed_for', yesterday)
    .in('status', ['sent', 'approved'])

  return tasks ?? []
}

// ── Pattern detection: stocked but unmarketed 30+ days ────────────────────

async function detectPatterns(supabase) {
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString()
  const { data: old } = await supabase
    .from('product_marketing_history')
    .select('product_ref, business, last_promoted_at')
    .lt('last_promoted_at', cutoff)
    .order('last_promoted_at', { ascending: true })
    .limit(10)
  return old ?? []
}

// ── Build task list for each staff member ─────────────────────────────────

function buildTasksForStaff(staff, rotationPicks, carryForward, yesterdaySales) {
  const tasks = []

  for (const carried of carryForward.filter(t => t.staff_id === staff.id)) {
    tasks.push({
      staffId:    staff.id,
      title:      `↩ ${carried.title} (গতকালের কাজ)`,
      detail:     carried.detail,
      type:       carried.type || 'misc',
      productRef: carried.product_ref,
      source:     'pattern',
    })
  }

  if (staff.role === 'content') {
    // Eyafi: content creation + order follow-up
    for (const pick of rotationPicks.slice(0, 2)) {
      tasks.push({
        staffId:    staff.id,
        title:      `${pick.name || pick.productRef} — কন্টেন্ট তৈরি করুন`,
        detail:     `কারণ: ${pick.reasons?.slice(0, 2).join('; ')}`,
        type:       pick.taskType || 'product_content',
        productRef: pick.productRef,
        source:     'rotation',
      })
    }
    if (yesterdaySales?.pendingOrders > 0) {
      tasks.push({
        staffId: staff.id,
        title:   `${yesterdaySales.pendingOrders}টি অর্ডার ফলো-আপ করুন`,
        type:    'order_followup',
        source:  'pattern',
      })
    }
  } else {
    // Mustahid: stock checks + COD + misc
    for (const pick of rotationPicks.slice(2, 4)) {
      tasks.push({
        staffId:    staff.id,
        title:      `${pick.name || pick.productRef} — স্টক চেক করুন`,
        detail:     pick.stock !== undefined ? `বর্তমান স্টক: ${pick.stock}` : undefined,
        type:       'stock_check',
        productRef: pick.productRef,
        source:     'rotation',
      })
    }
    tasks.push({
      staffId: staff.id,
      title:   'COD অর্ডার কনফার্ম করুন',
      type:    'order_followup',
      source:  'agent',
    })
  }

  return tasks
}

// ── Main morning proposal job ─────────────────────────────────────────────

export async function runMorningProposal(supabase) {
  console.log('[morning-proposal] starting...')

  try {
    // 1. Fetch staff list
    const { data: staffList } = await supabase
      .from('agent_staff')
      .select('id, name, role, telegram_chat_id')
      .eq('active', true)

    if (!staffList?.length) {
      console.warn('[morning-proposal] no active staff found')
      return
    }

    // 2. Get rotation picks
    const today = dhakaDateStr(0)
    const { picks: rotationPicks } = await getRotationPicks(supabase)

    // 3. Get carry-forward and pattern tasks
    const carryForward = await getCarryForwardTasks(supabase)

    // 4. Mark carried tasks
    if (carryForward.length > 0) {
      const ids = carryForward.map(t => t.id)
      await supabase
        .from('staff_tasks')
        .update({ status: 'carried' })
        .in('id', ids)
    }

    // 5. Yesterday's sales snapshot (best-effort)
    let yesterdaySales = { pendingOrders: 0 }
    try {
      const salesRes = await callInternal('/api/assistant/internal/agent-settings?keys=yesterday_pending_orders')
      yesterdaySales.pendingOrders = parseInt(salesRes.yesterday_pending_orders ?? '0', 10)
    } catch { /* non-fatal */ }

    // 6. Build task lists per staff
    const allTasks = []
    for (const staff of staffList) {
      const staffTasks = buildTasksForStaff(staff, rotationPicks, carryForward, yesterdaySales)
      allTasks.push(...staffTasks)
    }

    if (!allTasks.length) {
      console.warn('[morning-proposal] no tasks generated')
      return
    }

    // 7. Save proposed tasks via agent API
    const proposeResult = await callInternal('/api/assistant/chat?stream=false', 'POST', {
      message: `Morning proposal: propose_staff_tasks for ${today} with ${allTasks.length} tasks. Tasks: ${JSON.stringify(allTasks.slice(0, 5))}...`,
    })

    // Direct DB insert is more reliable for scheduler
    const { data: inserted, error: insertErr } = await supabase
      .from('staff_tasks')
      .delete()
      .eq('proposed_for', today)
      .eq('status', 'proposed')

    const taskData = allTasks.map(t => ({
      id:           crypto.randomUUID(),
      staff_id:     t.staffId,
      title:        t.title,
      detail:       t.detail ?? null,
      type:         t.type,
      product_ref:  t.productRef ?? null,
      status:       'proposed',
      proposed_for: today,
      source:       t.source,
      created_at:   new Date().toISOString(),
    }))

    await supabase.from('staff_tasks').insert(taskData)
    console.log(`[morning-proposal] inserted ${taskData.length} proposed tasks for ${today}`)

    // 8. Build approval card summary
    const cardLines = staffList.map(s => {
      const sTasks = allTasks.filter(t => t.staffId === s.id)
      return `*${s.name}* (${sTasks.length}টি কাজ):\n${sTasks.map(t => `  • ${t.title}`).join('\n')}`
    }).join('\n\n')

    const rotationSummary = rotationPicks.slice(0, 2)
      .map(p => `• ${p.name || p.productRef}: ${p.reasons?.[0] || ''}`)
      .join('\n')

    const carryNote = carryForward.length > 0
      ? `\n\n⚠️ গতকালের ${carryForward.length}টি অসম্পূর্ণ কাজ নতুন লিস্টে যোগ করা হয়েছে।`
      : ''

    const approvalMessage =
      `📋 *আজকের স্টাফ টাস্ক প্রস্তাব* — ${today}\n\n` +
      cardLines +
      carryNote +
      (rotationPicks.length > 0 ? `\n\n🔄 *রোটেশন পিক:*\n${rotationSummary}` : '')

    // Fetch task IDs just inserted
    const { data: insertedTasks } = await supabase
      .from('staff_tasks')
      .select('id')
      .eq('proposed_for', today)
      .eq('status', 'proposed')

    const taskIds = insertedTasks?.map(t => t.id) ?? []

    // Create pending action for approval
    const { data: pendingAction } = await supabase
      .from('agent_pending_actions')
      .insert({
        id:           crypto.randomUUID(),
        type:         'dispatch_staff_tasks',
        payload:      { date: today, taskIds },
        summary:      `স্টাফ টাস্ক ডিসপ্যাচ — ${today}\n\n${allTasks.map(t => `• ${t.title}`).join('\n')}`,
        cost_estimate: 0,
        status:       'pending',
        created_at:   new Date().toISOString(),
      })
      .select()
      .single()

    const pendingActionId = pendingAction?.id

    // 9. Send Telegram approval card to owner
    const { sendTelegramApprovalCard } = await import('../telegram/dispatcher.mjs')
    await sendTelegramApprovalCard({
      message:       approvalMessage,
      pendingActionId,
      approveLabel:  '✅ সব Approve',
      rejectLabel:   '❌ Cancel',
    })

    console.log(`[morning-proposal] approval card sent, action ${pendingActionId}`)
  } catch (err) {
    console.error('[morning-proposal] error:', err.message, err.stack)
    throw err
  }
}
