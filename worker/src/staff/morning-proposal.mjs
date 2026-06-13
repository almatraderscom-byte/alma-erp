/**
 * Staff task proposal — uses /api/assistant/internal/staff-task-proposal.
 * Evening job: targetOffsetDays=1 (tomorrow). Legacy morning proposal removed.
 */

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
  catch { return { raw: text, ok: res.ok } }
}

function dhakaDateStr(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** @param {{ targetOffsetDays?: number }} opts — 0=today, 1=tomorrow (evening proposal) */
export async function runTaskProposal(supabase, { targetOffsetDays = 0 } = {}) {
  const targetDate = dhakaDateStr(targetOffsetDays)
  const label = targetOffsetDays === 1 ? 'evening-proposal' : 'task-proposal'
  console.log(`[${label}] starting for ${targetDate}...`)

  try {
    const proposal = await callInternal(`/api/assistant/internal/staff-task-proposal?date=${targetDate}`)
    if (!proposal.success || !proposal.tasks?.length) {
      console.warn(`[${label}] no tasks from proposal API:`, proposal.error || proposal.raw)
      const { notify } = await import('../notify/index.mjs')
      await notify({
        tier: 1,
        title: label === 'evening-proposal' ? '🌙 আজ কোনো টাস্ক প্রস্তাব নেই' : 'টাস্ক প্রস্তাব',
        message: `${targetDate} — আজ কোনো task তৈরি হয়নি। ইনভেন্টরিতে active product কম, বা সব task আগেই complete।`,
        category: 'task',
      }).catch(() => {})
      return
    }

    const carryFrom = dhakaDateStr(targetOffsetDays - 1)
    await supabase
      .from('staff_tasks')
      .update({ status: 'carried' })
      .eq('proposed_for', carryFrom)
      .in('status', ['sent', 'approved'])

    await supabase.from('staff_tasks').delete().eq('proposed_for', targetDate).eq('status', 'proposed')

    const taskData = proposal.tasks.map((t) => ({
      id:           crypto.randomUUID(),
      staff_id:     t.staffId,
      title:        t.title,
      detail:       t.detail ?? null,
      type:         t.type,
      product_ref:  t.productRef ?? null,
      status:       'proposed',
      proposed_for: targetDate,
      source:       t.source,
      created_at:   new Date().toISOString(),
    }))

    await supabase.from('staff_tasks').insert(taskData)
    console.log(`[${label}] inserted ${taskData.length} proposed tasks for ${targetDate}`)

    const { data: insertedTasks } = await supabase
      .from('staff_tasks')
      .select('id')
      .eq('proposed_for', targetDate)
      .eq('status', 'proposed')

    const taskIds = insertedTasks?.map((t) => t.id) ?? []

    // Supersede any stale pending dispatch actions
    await supabase
      .from('agent_pending_actions')
      .update({ status: 'superseded', resolvedAt: new Date().toISOString() })
      .eq('type', 'dispatch_staff_tasks')
      .eq('status', 'pending')

    await supabase.from('agent_pending_actions').insert({
      id:           crypto.randomUUID(),
      type:         'dispatch_staff_tasks',
      payload:      { date: targetDate, taskIds },
      summary:      targetOffsetDays === 1
        ? `🌙 *আগামীকাল (${targetDate}) স্টাফ টাস্ক*\n\n${proposal.summaryBangla}`
        : proposal.summaryBangla,
      costEstimate: 0,
      status:       'pending',
      createdAt:    new Date().toISOString(),
    })

    const { sendTelegramApprovalCard } = await import('../telegram/dispatcher.mjs')
    const { data: pendingAction } = await supabase
      .from('agent_pending_actions')
      .select('id')
      .eq('status', 'pending')
      .eq('type', 'dispatch_staff_tasks')
      .order('createdAt', { ascending: false })
      .limit(1)
      .single()

    if (!pendingAction?.id) {
      console.error('[' + label + '] pending action not found — approval buttons will be missing')
    }
    await sendTelegramApprovalCard({
      message:       proposal.summaryBangla,
      pendingActionId: pendingAction?.id,
      approveLabel:  '✅ সব Approve',
      editLabel:     '✏️ সম্পাদনা',
      rejectLabel:   '❌ বাতিল',
    })

    console.log(`[${label}] approval card sent for ${taskData.length} tasks`)

    if (targetOffsetDays === 1) {
      const { notify } = await import('../notify/index.mjs')
      await notify({
        tier: 1,
        title: '🌙 আগামীকালের টাস্ক তৈরি হয়েছে',
        message: `${taskData.length}টি টাস্ক প্রস্তাবিত — Telegram-এ Approve করুন।`,
        category: 'task',
        ntfyMode: 'critical',
      }).catch(() => {})
    }
  } catch (err) {
    console.error(`[${label}] error:`, err.message, err.stack)
    throw err
  }
}

/** @deprecated Use runEveningProposal or runTaskProposal */
export async function runMorningProposal(supabase) {
  return runTaskProposal(supabase, { targetOffsetDays: 0 })
}
