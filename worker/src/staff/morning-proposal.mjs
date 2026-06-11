/**
 * Morning Proposal Job — runs at 09:00 Asia/Dhaka
 * Uses /api/assistant/internal/staff-task-proposal for data-driven tasks.
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

export async function runMorningProposal(supabase) {
  console.log('[morning-proposal] starting...')
  const today = dhakaDateStr(0)

  try {
    const proposal = await callInternal(`/api/assistant/internal/staff-task-proposal?date=${today}`)
    if (!proposal.success || !proposal.tasks?.length) {
      console.warn('[morning-proposal] no tasks from proposal API:', proposal.error || proposal.raw)
      return
    }

    // Mark yesterday carry-forward as carried
    const yesterday = dhakaDateStr(-1)
    await supabase
      .from('staff_tasks')
      .update({ status: 'carried' })
      .eq('proposed_for', yesterday)
      .in('status', ['sent', 'approved'])

    // Replace today's proposed tasks
    await supabase.from('staff_tasks').delete().eq('proposed_for', today).eq('status', 'proposed')

    const taskData = proposal.tasks.map((t) => ({
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

    const { data: insertedTasks } = await supabase
      .from('staff_tasks')
      .select('id')
      .eq('proposed_for', today)
      .eq('status', 'proposed')

    const taskIds = insertedTasks?.map((t) => t.id) ?? []

    await supabase.from('agent_pending_actions').insert({
      id:           crypto.randomUUID(),
      type:         'dispatch_staff_tasks',
      payload:      { date: today, taskIds },
      summary:      proposal.summaryBangla,
      cost_estimate: 0,
      status:       'pending',
      created_at:   new Date().toISOString(),
    })

    const { sendTelegramApprovalCard } = await import('../telegram/dispatcher.mjs')
    const { data: pendingAction } = await supabase
      .from('agent_pending_actions')
      .select('id')
      .eq('status', 'pending')
      .eq('type', 'dispatch_staff_tasks')
      .order('created_at', { ascending: false })
      .limit(1)
      .single()

    await sendTelegramApprovalCard({
      message:       proposal.summaryBangla,
      pendingActionId: pendingAction?.id,
      approveLabel:  '✅ সব Approve',
      rejectLabel:   '❌ Cancel',
    })

    console.log(`[morning-proposal] approval card sent for ${taskData.length} tasks`)
  } catch (err) {
    console.error('[morning-proposal] error:', err.message, err.stack)
    throw err
  }
}
