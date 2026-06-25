/**
 * Festival / Eid Marketing Trigger (#11).
 * Runs once a day (09:00 Dhaka). When a major Bangladeshi festival / shopping
 * occasion is within its lead window, nudges the owner to start a marketing push
 * (campaign, collection, offer). Each festival occurrence fires ONCE — dedup is
 * stored in the agent_marketing_nudges table (festival_key is per-year-unique).
 *
 * Gregorian festivals recur yearly automatically. Islamic festivals (Eid etc.)
 * shift each year, so they carry explicit dated entries that the owner/agent can
 * extend over time. Best-effort: any failure is logged and skipped.
 */
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const OWNER_CHAT_ID = () => process.env.TELEGRAM_OWNER_CHAT_ID

// Lead time (days before the festival) to start the marketing nudge.
const LEAD_DAYS = 12

/**
 * Fixed-date (Gregorian, recurring) occasions — month/day, fire every year.
 * Islamic / lunar occasions are explicit dated entries (need periodic top-up).
 */
const RECURRING_GREGORIAN = [
  { slug: 'pohela-boishakh', name: 'পহেলা বৈশাখ (বাংলা নববর্ষ)', mm: 4, dd: 14 },
  { slug: 'independence-day', name: 'স্বাধীনতা দিবস', mm: 3, dd: 26 },
  { slug: 'victory-day', name: 'বিজয় দিবস', mm: 12, dd: 16 },
  { slug: 'valentines', name: 'ভ্যালেন্টাইনস ডে', mm: 2, dd: 14 },
  { slug: 'falgun', name: 'পহেলা ফাল্গুন (বসন্ত)', mm: 2, dd: 13 },
]

/**
 * Explicit dated occasions (Islamic/lunar — approximate, update yearly).
 * Keep future-dated entries here so they fire at the right lead time.
 */
const DATED = [
  { slug: 'eid-ul-fitr-2027', name: 'ঈদুল ফিতর ২০২৭', date: '2027-03-20' },
  { slug: 'eid-ul-adha-2027', name: 'ঈদুল আযহা ২০২৭', date: '2027-05-27' },
  { slug: 'eid-ul-fitr-2028', name: 'ঈদুল ফিতর ২০২৮', date: '2028-03-09' },
  { slug: 'eid-ul-adha-2028', name: 'ঈদুল আযহা ২০২৮', date: '2028-05-15' },
]

function dhakaTodayYmd() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function ymdToDhakaMs(ymd) {
  return new Date(`${ymd}T00:00:00+06:00`).getTime()
}

/** For a recurring Gregorian month/day, the next yyyy-MM-dd occurrence (this year or next). */
function nextGregorianYmd(mm, dd, todayYmd) {
  const [ty] = todayYmd.split('-').map(Number)
  const build = (yy) => `${yy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  const thisYear = build(ty)
  return thisYear >= todayYmd ? thisYear : build(ty + 1)
}

export async function runFestivalMarketing(context) {
  const { supabase, bot } = context
  if (!OWNER_CHAT_ID() || !bot) return { dutyStatus: 'skipped', dutyDetail: 'no owner chat' }

  const today = dhakaTodayYmd()
  const todayMs = ymdToDhakaMs(today)

  // Build the candidate list with each festival's next occurrence + a stable key.
  const candidates = []
  for (const f of RECURRING_GREGORIAN) {
    const ymd = nextGregorianYmd(f.mm, f.dd, today)
    const year = ymd.slice(0, 4)
    candidates.push({ key: `${f.slug}-${year}`, name: f.name, ymd })
  }
  for (const f of DATED) {
    if (f.date >= today) candidates.push({ key: f.slug, name: f.name, ymd: f.date })
  }

  // Within lead window?
  const due = candidates
    .map((c) => ({ ...c, daysUntil: Math.round((ymdToDhakaMs(c.ymd) - todayMs) / 86_400_000) }))
    .filter((c) => c.daysUntil >= 0 && c.daysUntil <= LEAD_DAYS)
    .sort((a, b) => a.daysUntil - b.daysUntil)

  if (!due.length) return { dutyStatus: 'done', dutyDetail: 'no festival in lead window' }

  let sent = 0
  for (const f of due) {
    // Dedup: skip if we already nudged for this occurrence.
    try {
      const { data: existing } = await supabase
        .from('agent_marketing_nudges')
        .select('id')
        .eq('festival_key', f.key)
        .limit(1)
      if (existing && existing.length) continue
    } catch (e) {
      console.warn('[festival-marketing] dedup check failed:', e.message)
      // If we can't verify, skip to avoid spamming.
      continue
    }

    const when = f.daysUntil === 0 ? 'আজ' : `${f.daysUntil} দিন পর`
    const msg =
      `🎉 *${f.name} আসছে — ${when} (${f.ymd})*\n\n` +
      `Sir, মার্কেটিং পুশ শুরু করার সময় হয়েছে:\n` +
      `  • festival কালেকশন / অফার ঠিক করুন\n` +
      `  • ক্যাম্পেইন ও ক্রিয়েটিভ প্ল্যান করুন\n` +
      `  • স্টক ও কুরিয়ার প্রস্তুত রাখুন\n\n` +
      `চাইলে বলুন — আমি ক্যাম্পেইন আইডিয়া বা কনটেন্ট প্ল্যান বানিয়ে দিই।`

    try {
      await sendMarkdownSafe(bot.telegram, OWNER_CHAT_ID(), msg)
      await supabase
        .from('agent_marketing_nudges')
        .insert({ festival_key: f.key, festival_name: f.name, festival_date: f.ymd })
      sent += 1
    } catch (e) {
      console.warn('[festival-marketing] send/insert failed:', e.message)
    }
  }

  return { dutyStatus: 'done', dutyDetail: `${sent} festival nudge(s) sent` }
}
