import { replyMarkdownSafe } from '../telegram/markdown-safe.mjs'

/**
 * Finance module — Telegram command handlers.
 * /pawna  — grouped receivables + payables per currency
 * /details <name> — full ledger history, paginated (18+ entries, BDT+AED)
 *
 * Data fetched via the agent internal API (Vercel).
 * Finance data is NEVER sent to staff — only to owner.
 */

const APP_URL   = process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = process.env.AGENT_INTERNAL_TOKEN ?? ''

async function fetchLedgerBalances(person = null) {
  const url = person
    ? `${APP_URL}/api/assistant/internal/agent-settings?keys=_` // placeholder — use direct query
    : `${APP_URL}/api/assistant/internal/agent-settings?keys=_`

  // Use the agent chat route to get balances (it has the finance tools)
  const res = await fetch(`${APP_URL}/api/assistant/chat?stream=false`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN}` },
    body: JSON.stringify({
      message: person
        ? `get_ledger_balances for person "${person}"`
        : 'get_ledger_balances for all people',
    }),
  })

  if (!res.ok) throw new Error(`Finance API ${res.status}`)
  const data = await res.json()
  return data
}

/**
 * /pawna — shows grouped receivables + payables per currency
 */
export async function handlePawnaCommand(ctx, supabase) {
  try {
    // Direct DB query for reliability
    const { data: rows } = await supabase
      .from('finance_ledger')
      .select('person_name, direction, amount, currency')
      .order('person_name')

    if (!rows?.length) {
      await ctx.reply('কোনো পাওনা-দেনার রেকর্ড নেই।')
      return
    }

    // Compute balances per person per currency
    const balances = {}
    for (const r of rows) {
      const key = r.person_name.toLowerCase()
      if (!balances[key]) balances[key] = { name: r.person_name, BDT: 0, AED: 0 }
      const sign = (r.direction === 'lent' || r.direction === 'repaid_to_me') ? 1 : -1
      balances[key][r.currency] += sign * r.amount
    }

    // Separate receivables (positive) and payables (negative)
    const receivables = []
    const payables    = []

    for (const b of Object.values(balances)) {
      const bdtOwed = b.BDT
      const aedOwed = b.AED
      const parts = []
      if (Math.abs(bdtOwed) > 0) parts.push(`৳${Math.abs(bdtOwed).toLocaleString('bn-BD')}`)
      if (Math.abs(aedOwed) > 0) parts.push(`AED ${Math.abs(aedOwed).toFixed(2)}`)
      if (!parts.length) continue

      if (bdtOwed > 0 || aedOwed > 0) {
        receivables.push(`• *${b.name}*: ${parts.join(', ')} পাওনা`)
      } else {
        payables.push(`• *${b.name}*: ${parts.join(', ')} দেনা`)
      }
    }

    let msg = '💰 *পাওনা-দেনার সারসংক্ষেপ*\n\n'
    if (receivables.length) msg += `📥 *পাওনা (আপনার পাওয়া):*\n${receivables.join('\n')}\n\n`
    if (payables.length)    msg += `📤 *দেনা (আপনার দেওয়া):*\n${payables.join('\n')}`
    if (!receivables.length && !payables.length) msg += 'সব হিসাব শূন্য।'

    await replyMarkdownSafe(ctx, msg)
  } catch (err) {
    console.error('[finance] /pawna error:', err.message)
    await ctx.reply(`❌ হিসাব আনা যায়নি: ${err.message}`)
  }
}

/**
 * /details <name> — full paginated history for a person
 */
export async function handleDetailsCommand(ctx, name, supabase, page = 0) {
  const PAGE_SIZE = 10

  try {
    const { data: rows, count } = await supabase
      .from('finance_ledger')
      .select('*', { count: 'exact' })
      .ilike('person_name', `%${name}%`)
      .order('occurred_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1)

    if (!rows?.length) {
      await ctx.reply(`"${name}"-এর কোনো রেকর্ড নেই।`)
      return
    }

    const directionBn = {
      lent:          '→ ধার দিলেন',
      borrowed:      '← ধার নিলেন',
      repaid_to_me:  '↩ ফেরত পেলেন',
      repaid_by_me:  '↪ ফেরত দিলেন',
    }

    const lines = rows.map(r => {
      const date = new Date(r.occurred_at).toLocaleDateString('bn-BD', { timeZone: 'Asia/Dhaka' })
      const amount = r.currency === 'AED'
        ? `AED ${r.amount.toFixed(2)}`
        : `৳${r.amount.toLocaleString('bn-BD')}`
      const dir = directionBn[r.direction] || r.direction
      return `${date}: ${dir} *${amount}*${r.note ? ` — ${r.note}` : ''}`
    })

    const totalPages = Math.ceil((count || 0) / PAGE_SIZE)
    const header = `📋 *${name}-এর হিসাব* (পৃষ্ঠা ${page + 1}/${totalPages})\n\n`

    const buttons = []
    if (page > 0)            buttons.push({ text: '◀ আগে',   callback_data: `details:${name}:${page - 1}` })
    if (page < totalPages - 1) buttons.push({ text: 'পরে ▶', callback_data: `details:${name}:${page + 1}` })

    await replyMarkdownSafe(
      ctx,
      header + lines.join('\n'),
      buttons.length ? { reply_markup: { inline_keyboard: [buttons] } } : {},
    )
  } catch (err) {
    console.error('[finance] /details error:', err.message)
    await ctx.reply(`❌ হিসাব আনা যায়নি: ${err.message}`)
  }
}
