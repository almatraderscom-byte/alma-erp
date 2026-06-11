/**
 * Compute first-reply times from FB conversation threads.
 * No customer message content stored — only timestamps.
 */

const PAGE_STAFF_MAP = {
  '1044848232034171': 'content',   // Alma Lifestyle → content staff (Eyafi)
  '827260860637393':  'warehouse', // Alma Online Shop → warehouse (Mustahid)
}

function dhakaDate(iso) {
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/**
 * @param {object} opts
 * @param {import('@supabase/supabase-js').SupabaseClient} opts.supabase
 * @param {string} opts.pageId
 * @param {string} opts.conversationId
 * @param {Array<{from?:{id?:string}, created_time?:string}>} opts.messages
 */
export async function recordReplyStats({ supabase, pageId, conversationId, messages }) {
  if (!messages?.length) return 0

  const sorted = [...messages].sort(
    (a, b) => new Date(a.created_time) - new Date(b.created_time),
  )

  // Resolve staff by page role
  const roleHint = PAGE_STAFF_MAP[pageId]
  let staffId = null
  if (roleHint) {
    const { data: staffRows } = await supabase
      .from('agent_staff')
      .select('id, role')
      .eq('active', true)
    const match = staffRows?.find((s) => s.role === roleHint)
      ?? staffRows?.find((s) => roleHint === 'content' && /content/i.test(s.role))
    staffId = match?.id ?? null
  }

  let inserted = 0
  const now = Date.now()
  const lookbackMs = 48 * 60 * 60 * 1000

  for (let i = 0; i < sorted.length; i++) {
    const msg = sorted[i]
    const isCustomer = msg.from?.id !== pageId
    if (!isCustomer || !msg.created_time) continue

    const custAt = new Date(msg.created_time).getTime()
    if (now - custAt > lookbackMs) continue

    // Find first page reply after this customer message
    let firstReply = null
    for (let j = i + 1; j < sorted.length; j++) {
      if (sorted[j].from?.id === pageId && sorted[j].created_time) {
        firstReply = sorted[j]
        break
      }
    }
    if (!firstReply) continue

    const replyAt = new Date(firstReply.created_time).getTime()
    const replyMinutes = Math.max(1, Math.round((replyAt - custAt) / 60000))
    const date = dhakaDate(msg.created_time)

    // Dedupe: same conversation + customer_msg_at
    const { data: existing } = await supabase
      .from('staff_reply_stats')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('customer_msg_at', msg.created_time)
      .limit(1)

    if (existing?.length > 0) continue

    await supabase.from('staff_reply_stats').insert({
      id:              crypto.randomUUID(),
      staff_id:        staffId,
      page_id:         pageId,
      conversation_id: conversationId,
      customer_msg_at: msg.created_time,
      first_reply_at:  firstReply.created_time,
      reply_minutes:   replyMinutes,
      date,
      created_at:      new Date().toISOString(),
    })
    inserted++
  }

  return inserted
}

/**
 * Aggregate avg/median reply minutes per staff for a date.
 */
export async function aggregateReplyStats(supabase, date) {
  const { data: rows } = await supabase
    .from('staff_reply_stats')
    .select('staff_id, reply_minutes, agent_staff(name)')
    .eq('date', date)

  if (!rows?.length) return []

  const byStaff = {}
  for (const r of rows) {
    const name = r.agent_staff?.name ?? 'অজানা'
    const key = r.staff_id ?? name
    if (!byStaff[key]) byStaff[key] = { name, minutes: [] }
    byStaff[key].minutes.push(r.reply_minutes)
  }

  return Object.values(byStaff).map(({ name, minutes }) => {
    const sorted = [...minutes].sort((a, b) => a - b)
    const avg = Math.round(minutes.reduce((s, m) => s + m, 0) / minutes.length)
    const mid = sorted[Math.floor(sorted.length / 2)]
    return { name, count: minutes.length, avgMinutes: avg, medianMinutes: mid }
  })
}
