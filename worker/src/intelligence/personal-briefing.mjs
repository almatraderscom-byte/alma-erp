/**
 * Personal Daily Briefing — the owner's personal-life morning rundown.
 * Runs at 07:50 Dhaka (just after the focus plan at 07:45).
 *
 * Gathers (Supabase, snake_case tables — the worker can't import Next/Prisma):
 *   - today's salah status (salah_records)
 *   - bills due soon / overdue (agent_bills)
 *   - upcoming birthdays / anniversaries / Islamic dates (agent_important_dates)
 *   - this-month expense burn (finance_expenses)
 *   - today's reminders (agent_reminders)
 * Then sends one Bangla Telegram message. Best-effort: any failing section is
 * simply omitted; the briefing is skipped entirely only if there is nothing to say.
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const OWNER_CHAT_ID = () => process.env.TELEGRAM_OWNER_CHAT_ID

const BILL_WINDOW_DAYS = 5
const DATE_WINDOW_DAYS = 14

function dhakaTodayYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

/** yyyy-MM-dd → epoch ms at Dhaka midnight (UTC+6). */
function ymdToDhakaMs(ymd) {
  return new Date(`${ymd}T00:00:00+06:00`).getTime()
}

function addDaysYmd(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}

/** For a recurring Gregorian date, next yyyy-MM-dd occurrence (this year or next). */
function nextOccurrenceYmd(eventYmd, recurring, calendar, todayYmd) {
  if (!recurring || calendar !== 'gregorian') return eventYmd
  const [, m, d] = eventYmd.split('-').map(Number)
  const [ty] = todayYmd.split('-').map(Number)
  const build = (yy) => {
    const lastDay = new Date(Date.UTC(yy, m, 0)).getUTCDate()
    const day = Math.min(d, lastDay)
    return `${yy}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  const thisYear = build(ty)
  return thisYear >= todayYmd ? thisYear : build(ty + 1)
}

function fmtTk(n) {
  return `৳${Number(n || 0).toLocaleString('en-US')}`
}

export async function runPersonalBriefing(context) {
  const { supabase, bot } = context
  if (!OWNER_CHAT_ID() || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat' }

  const today = dhakaTodayYmd()
  const todayMs = ymdToDhakaMs(today)
  const dayStartIso = new Date(todayMs).toISOString()
  const dayEndIso = new Date(todayMs + 86_400_000).toISOString()

  // Month bounds (Dhaka) for expense burn.
  const [yy, mm] = today.split('-').map(Number)
  const monthStartIso = new Date(`${yy}-${String(mm).padStart(2, '0')}-01T00:00:00+06:00`).toISOString()
  const nextMonth = mm === 12 ? [yy + 1, 1] : [yy, mm + 1]
  const monthEndIso = new Date(`${nextMonth[0]}-${String(nextMonth[1]).padStart(2, '0')}-01T00:00:00+06:00`).toISOString()

  const billHorizonIso = new Date(ymdToDhakaMs(addDaysYmd(today, BILL_WINDOW_DAYS)) + 86_400_000).toISOString()

  const safe = async (p) => {
    try {
      const r = await p
      return r?.data ?? []
    } catch {
      return []
    }
  }

  const [salahRows, salahWindowRows, reminderRows, billRows, dateRows, expenseRows, apptRows, medRows] =
    await Promise.all([
    safe(supabase.from('salah_records').select('waqt, status').eq('date', today)),
    safe(supabase.from('salah_records').select('waqt, window_start, window_end').eq('date', today)),
    safe(
      supabase
        .from('agent_reminders')
        .select('title, due_at')
        .eq('status', 'pending')
        .gte('due_at', dayStartIso)
        .lt('due_at', dayEndIso)
        .order('due_at')
        .limit(20),
    ),
    safe(
      supabase
        .from('agent_bills')
        .select('name, amount, currency, next_due_at')
        .eq('active', true)
        .not('next_due_at', 'is', null)
        .lt('next_due_at', billHorizonIso)
        .order('next_due_at')
        .limit(50),
    ),
    safe(
      supabase
        .from('agent_important_dates')
        .select('title, type, event_date, recurring, calendar')
        .eq('active', true)
        .limit(200),
    ),
    safe(
      supabase
        .from('finance_expenses')
        .select('amount, occurred_at')
        .eq('deleted', false)
        .gte('occurred_at', monthStartIso)
        .lt('occurred_at', monthEndIso)
        .limit(2000),
    ),
    safe(
      supabase
        .from('agent_appointments')
        .select('title, location, start_at')
        .eq('status', 'scheduled')
        .gte('start_at', dayStartIso)
        .lt('start_at', dayEndIso)
        .order('start_at')
        .limit(30),
    ),
    safe(
      supabase
        .from('agent_medications')
        .select('name, dosage, times, start_date, end_date')
        .eq('active', true)
        .limit(50),
    ),
  ])

  // ── Salah ──
  const DONE = ['completed', 'done', 'prayed', 'confirmed']
  const MISSED = ['missed', 'qaza']
  let salahLine = ''
  if (salahRows.length) {
    const done = salahRows.filter((r) => DONE.includes(r.status)).length
    const missed = salahRows.filter((r) => MISSED.includes(r.status)).length
    salahLine = `🕌 নামাজ: ${done}/${salahRows.length} আদায়${missed ? `, ${missed} ছুটেছে` : ''}`
  }

  // ── Bills due soon / overdue ──
  const bills = billRows
    .map((b) => {
      const ymd = String(b.next_due_at).slice(0, 10)
      const daysUntil = Math.round((ymdToDhakaMs(ymd) - todayMs) / 86_400_000)
      return { name: b.name, amount: b.amount, currency: b.currency, ymd, daysUntil }
    })
    .sort((a, b) => a.daysUntil - b.daysUntil)

  // ── Important dates ──
  const dates = dateRows
    .map((r) => {
      const eventYmd = String(r.event_date).slice(0, 10)
      const nextYmd = nextOccurrenceYmd(eventYmd, r.recurring, r.calendar, today)
      const daysUntil = Math.round((ymdToDhakaMs(nextYmd) - todayMs) / 86_400_000)
      return { title: r.title, type: r.type, nextYmd, daysUntil }
    })
    .filter((x) => x.daysUntil >= 0 && x.daysUntil <= DATE_WINDOW_DAYS)
    .sort((a, b) => a.daysUntil - b.daysUntil)

  // ── Expense burn ──
  const monthBurn = expenseRows.reduce((s, e) => s + Number(e.amount || 0), 0)
  const todayBurn = expenseRows
    .filter((e) => {
      const t = new Date(e.occurred_at).getTime()
      return t >= todayMs && t < todayMs + 86_400_000
    })
    .reduce((s, e) => s + Number(e.amount || 0), 0)

  // ── Reminders ──
  const reminders = reminderRows.map((r) => ({
    title: r.title,
    time: String(r.due_at).slice(11, 16),
  }))

  // ── Appointments today (with salah-window conflict flag) ──
  const fmtTimeDhaka = (iso) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(iso))
  const appointments = apptRows.map((a) => {
    const t = new Date(a.start_at).getTime()
    const clash = salahWindowRows.find(
      (w) => t >= new Date(w.window_start).getTime() && t < new Date(w.window_end).getTime(),
    )
    return { title: a.title, location: a.location, time: fmtTimeDhaka(a.start_at), salahConflict: clash ? clash.waqt : null }
  })

  // ── Medications due today (active + within course window) ──
  const meds = medRows
    .filter((m) => {
      const startOk = !m.start_date || String(m.start_date).slice(0, 10) <= today
      const endOk = !m.end_date || String(m.end_date).slice(0, 10) >= today
      return startOk && endOk
    })
    .map((m) => ({ name: m.name, dosage: m.dosage, times: m.times }))

  // ── Compose ──
  const L = ['🌅 *আজকের ব্যক্তিগত ব্রিফিং*', '']
  let hasContent = false

  if (salahLine) {
    L.push(salahLine, '')
    hasContent = true
  }

  if (bills.length) {
    L.push('💳 *বিল/সাবস্ক্রিপশন:*')
    bills.forEach((b) => {
      const when =
        b.daysUntil < 0
          ? `⚠️ ${Math.abs(b.daysUntil)} দিন overdue`
          : b.daysUntil === 0
            ? 'আজ due'
            : `${b.daysUntil} দিন পর`
      L.push(`  • ${b.name} — ${fmtTk(b.amount)} (${when})`)
    })
    L.push('')
    hasContent = true
  }

  if (dates.length) {
    L.push('📅 *সামনের গুরুত্বপূর্ণ দিন:*')
    dates.forEach((d) => {
      const when = d.daysUntil === 0 ? 'আজ' : `${d.daysUntil} দিন পর`
      L.push(`  • ${d.title} — ${when} (${d.nextYmd})`)
    })
    L.push('')
    hasContent = true
  }

  if (appointments.length) {
    L.push('🗓️ *আজকের অ্যাপয়েন্টমেন্ট:*')
    appointments.forEach((a) => {
      const loc = a.location ? ` @ ${a.location}` : ''
      const warn = a.salahConflict ? ` ⚠️ (${a.salahConflict} নামাজের সময়)` : ''
      L.push(`  • ${a.time} — ${a.title}${loc}${warn}`)
    })
    L.push('')
    hasContent = true
  }

  if (meds.length) {
    L.push('💊 *আজকের ওষুধ:*')
    meds.slice(0, 12).forEach((m) => {
      const dose = m.dosage ? ` (${m.dosage})` : ''
      const times = m.times ? ` — ${m.times}` : ''
      L.push(`  • ${m.name}${dose}${times}`)
    })
    L.push('')
    hasContent = true
  }

  if (reminders.length) {
    L.push('⏰ *আজকের রিমাইন্ডার:*')
    reminders.slice(0, 8).forEach((r) => L.push(`  • ${r.time} — ${r.title}`))
    L.push('')
    hasContent = true
  }

  if (monthBurn > 0) {
    L.push(`💰 এ মাসের খরচ: ${fmtTk(monthBurn)}${todayBurn > 0 ? ` (আজ ${fmtTk(todayBurn)})` : ''}`)
    hasContent = true
  }

  if (!hasContent) {
    return { dutyStatus: 'done', dutyDetail: 'nothing to brief' }
  }

  await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID(), L.join('\n').trim())

  return {
    dutyStatus: 'done',
    dutyDetail: `briefing sent (${bills.length} bills, ${dates.length} dates, ${appointments.length} appts, ${meds.length} meds, ${reminders.length} reminders)`,
  }
}
