/**
 * Deterministic Bangla/Banglish time-expression resolver (Asia/Dhaka).
 *
 * Voice/chat reminder requests carry times the way the owner actually speaks —
 * "বিকাল ৪টায়", "amake 4 tay call dio", "সাড়ে ৯টার সময়", "কাল সকাল ১০টায়",
 * "৩০ মিনিট পর" — and resolving them was left entirely to the head model, which
 * live-misread "4 tay" as "4 calls" (rc-0171's sister failure). This module
 * resolves the expression BEFORE the model sees it, so set_reminder gets an
 * exact ISO dueAt instead of a guess.
 *
 * Contract:
 *  - Pure function of (text, now). Never throws; returns null when no confident
 *    time expression is found (precision-biased — a wrong time on a phone call
 *    reminder is worse than asking).
 *  - Dhaka is UTC+6 with no DST, so wall-time math is done with a fixed offset.
 */
import { bnDigitsToAscii, B_L, B_R } from './bangla-text'

export interface ResolvedBanglaTime {
  /** ISO 8601 with +06:00 offset — feed straight into set_reminder.dueAt. */
  iso: string
  /** Bangla label for confirmations, e.g. "আজ বিকাল ৪:০০". */
  label: string
  /** The exact substring that was interpreted (evidence for the head). */
  matched: string
}

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000

/** Word → hour numbers (Bangla + Banglish), 1-12. */
const HOUR_WORDS: Record<string, number> = {
  'এক': 1, 'দুই': 2, 'তিন': 3, 'চার': 4, 'পাঁচ': 5, 'ছয়': 6, 'সাত': 7,
  'আট': 8, 'নয়': 9, 'দশ': 10, 'এগারো': 11, 'এগারোটা': 11, 'বারো': 12,
  ek: 1, dui: 2, tin: 3, char: 4, pach: 5, panch: 5, choy: 6, chhoy: 6,
  shat: 7, sat: 7, aat: 8, noy: 9, dosh: 10, egaro: 11, baro: 12,
}

/** Dayparts → how a 1-12 hour maps onto 24h. */
type Daypart = 'bhor' | 'shokal' | 'dupur' | 'bikal' | 'shondha' | 'rat'
const DAYPART_RE: Array<{ part: Daypart; re: RegExp }> = [
  { part: 'bhor', re: new RegExp(`(?<!${B_L})(?:ভোর|bhor|bhore)(?!${B_R})`, 'i') },
  { part: 'shokal', re: new RegExp(`(?<!${B_L})(?:সকাল|সকালে|shokal|shokale|sokal|sokale|morning)(?!${B_R})`, 'i') },
  { part: 'dupur', re: new RegExp(`(?<!${B_L})(?:দুপুর|দুপুরে|dupur|dupure|noon)(?!${B_R})`, 'i') },
  { part: 'bikal', re: new RegExp(`(?<!${B_L})(?:বিকাল|বিকালে|বিকেল|বিকেলে|bikal|bikale|bikel|bikele|afternoon)(?!${B_R})`, 'i') },
  { part: 'shondha', re: new RegExp(`(?<!${B_L})(?:সন্ধ্যা|সন্ধ্যায়|shondha|shondhay|sondha|sondhay|evening)(?!${B_R})`, 'i') },
  { part: 'rat', re: new RegExp(`(?<!${B_L})(?:রাত|রাতে|rat|rate|raat|raate|night)(?!${B_R})`, 'i') },
]

const DAYPART_LABEL: Record<Daypart, string> = {
  bhor: 'ভোর', shokal: 'সকাল', dupur: 'দুপুর', bikal: 'বিকাল', shondha: 'সন্ধ্যা', rat: 'রাত',
}

function hourTo24(h12: number, part: Daypart | null): number {
  const h = h12 % 12 // 12টা → 0 within the part's window
  switch (part) {
    case 'bhor': return h === 0 ? 4 : h // ভোর ১২টা isn't a thing; ভোর ৪/৫টা
    case 'shokal': return h // সকাল ১০টা → 10
    case 'dupur': return h === 0 ? 12 : h < 4 ? h + 12 : h // দুপুর ১২/১/২/৩
    case 'bikal': return h + 12 // বিকাল ৩-৬
    case 'shondha': return h + 12 // সন্ধ্যা ৬-৮
    case 'rat': return h === 0 ? 0 : h >= 7 ? h + 12 : h // রাত ৮-১১→20-23, রাত ১২→0, রাত ১/২→1/2
    default: return h12 // resolved later against "next future"
  }
}

/** Dhaka wall-clock parts for a UTC instant. */
function dhakaParts(now: Date) {
  const d = new Date(now.getTime() + DHAKA_OFFSET_MS)
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth(), day: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(),
  }
}

/** Build a UTC instant from Dhaka wall-clock fields. */
function fromDhaka(y: number, mo: number, day: number, h: number, mi: number): Date {
  return new Date(Date.UTC(y, mo, day, h, mi) - DHAKA_OFFSET_MS)
}

function toIsoDhaka(d: Date): string {
  const w = new Date(d.getTime() + DHAKA_OFFSET_MS)
  const p = (n: number, l = 2) => String(n).padStart(l, '0')
  return (
    `${w.getUTCFullYear()}-${p(w.getUTCMonth() + 1)}-${p(w.getUTCDate())}` +
    `T${p(w.getUTCHours())}:${p(w.getUTCMinutes())}:00+06:00`
  )
}

const BN_NUM = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯']
function bnNum(n: number): string {
  return String(n).split('').map((c) => (/\d/.test(c) ? BN_NUM[Number(c)] : c)).join('')
}

function labelFor(due: Date, now: Date, part: Daypart | null): string {
  const dNow = dhakaParts(now)
  const dDue = dhakaParts(due)
  const today = Date.UTC(dNow.y, dNow.mo, dNow.day)
  const dueDay = Date.UTC(dDue.y, dDue.mo, dDue.day)
  const diffDays = Math.round((dueDay - today) / 86_400_000)
  const dayLabel = diffDays === 0 ? 'আজ' : diffDays === 1 ? 'কাল' : diffDays === 2 ? 'পরশু' : `${bnNum(diffDays)} দিন পরে`
  const h24 = dDue.h
  const inferredPart: Daypart =
    part ?? (h24 < 4 ? 'rat' : h24 < 6 ? 'bhor' : h24 < 12 ? 'shokal' : h24 < 15 ? 'dupur' : h24 < 18 ? 'bikal' : h24 < 20 ? 'shondha' : 'rat')
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${dayLabel} ${DAYPART_LABEL[inferredPart]} ${bnNum(h12)}:${bnNum(dDue.mi).padStart(2, '০')}`
}

// ── Relative expressions: "৩০ মিনিট পর", "ek ghonta pore", "আধা ঘণ্টা বাদে" ──
const REL_MIN = new RegExp(
  `(\\d{1,3})\\s*(?:মিনিট|min(?:ute)?s?|mint|mnt)\\s*(?:পরে?|পর|বাদে|por|pore|bade|later)(?!${B_R})`, 'i')
const REL_HOUR = new RegExp(
  `(\\d{1,2})\\s*(?:ঘণ্টা|ঘন্টা|ghonta|ghanta|hours?|hr)\\s*(?:পরে?|পর|বাদে|por|pore|bade|later)(?!${B_R})`, 'i')
const REL_HALF = new RegExp(
  `(?:আধা?\\s*ঘণ্টা|আধ\\s*ঘন্টা|adha\\s*gh[ao]nta|half\\s*(?:an\\s*)?hour)\\s*(?:পরে?|পর|বাদে|por|pore|bade|later)(?!${B_R})`, 'i')
const REL_HOUR_WORD = new RegExp(
  `(?<!${B_L})(ek|dui|tin|char|এক|দুই|তিন|চার)\\s*(?:ঘণ্টা|ঘন্টা|ghonta|ghanta|hour)\\s*(?:পরে?|পর|বাদে|por|pore|bade|later)(?!${B_R})`, 'i')

// ── Day words ──
const TOMORROW_RE = new RegExp(`(?<!${B_L})(?:আগামীকাল|আগামী\\s*কাল|কাল(?:কে)?|kal(?:ke)?|agami\\s*kal|tomorrow)(?!${B_R})`, 'i')
const DAY_AFTER_RE = new RegExp(`(?<!${B_L})(?:পরশু|porshu|day\\s*after\\s*tomorrow)(?!${B_R})`, 'i')

// ── Absolute clock expressions ──
// "৪টা / 4টায় / 4 tay / ৪ টার সময় / 4:30 tay / 10 pm / সাড়ে ৪টা / পৌনে ৫টা / সোয়া ৯টা"
const HOUR_WORD_ALT = Object.keys(HOUR_WORDS).join('|')
const CLOCK_RE = new RegExp(
  `(?:(সাড়ে|sare|share|পৌনে|poune|pone|সোয়া|soa|showa)\\s*)?` +
  `(?:(\\d{1,2})(?::(\\d{2}))?|(?<!${B_L})(${HOUR_WORD_ALT}))\\s*` +
  `(?:টা(?:য়|র|তে)?|ta(?:y|te)?|tar)(?:\\s*(?:সময়|shomoy|somoy|dike|দিকে))?(?!${B_R})` +
  `|(?:(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)(?!${B_R}))`,
  'i')

/**
 * Resolve the first confident Bangla/Banglish time expression in `text`.
 * Returns null when nothing confidently time-like is present.
 */
export function resolveBanglaTimeExpression(textRaw: string, now = new Date()): ResolvedBanglaTime | null {
  const text = bnDigitsToAscii(String(textRaw || '')).toLowerCase()
  if (!text.trim()) return null

  // 1 — relative ("X মিনিট পর") wins: unambiguous and common in voice.
  {
    let ms: number | null = null
    let matched = ''
    const mMin = text.match(REL_MIN)
    const mHalf = text.match(REL_HALF)
    const mHr = text.match(REL_HOUR)
    const mHrW = text.match(REL_HOUR_WORD)
    if (mMin) { ms = Number(mMin[1]) * 60_000; matched = mMin[0] }
    else if (mHalf) { ms = 30 * 60_000; matched = mHalf[0] }
    else if (mHr) { ms = Number(mHr[1]) * 3_600_000; matched = mHr[0] }
    else if (mHrW) { ms = (HOUR_WORDS[mHrW[1].toLowerCase()] ?? 1) * 3_600_000; matched = mHrW[0] }
    if (ms != null && ms > 0 && ms <= 14 * 24 * 3_600_000) {
      const due = new Date(now.getTime() + ms)
      return { iso: toIsoDhaka(due), label: labelFor(due, now, null), matched: matched.trim() }
    }
  }

  // 2 — absolute clock time.
  const m = text.match(CLOCK_RE)
  if (!m) return null
  const matched = m[0].trim()

  const half = m[1] ?? null
  let hour12: number
  let minute = 0
  let ampm: 'am' | 'pm' | null = null
  if (m[2] != null) {
    hour12 = Number(m[2])
    minute = m[3] != null ? Number(m[3]) : 0
  } else if (m[4] != null) {
    hour12 = HOUR_WORDS[m[4].toLowerCase()] ?? NaN
  } else {
    hour12 = Number(m[5])
    minute = m[6] != null ? Number(m[6]) : 0
    ampm = (m[7]?.toLowerCase() as 'am' | 'pm') ?? null
  }
  if (!Number.isFinite(hour12) || hour12 < 0 || hour12 > 23 || minute < 0 || minute > 59) return null

  // সাড়ে/পৌনে/সোয়া modify the half hour (only valid with a bare hour).
  if (half && minute === 0) {
    const h = half
    if (/সাড়ে|sare|share/i.test(h)) minute = 30
    else if (/সোয়া|soa|showa/i.test(h)) minute = 15
    else if (/পৌনে|poune|pone/i.test(h)) { minute = 45; hour12 = hour12 === 1 ? 12 : hour12 - 1 }
  }

  // Daypart word anywhere in the message disambiguates am/pm.
  let part: Daypart | null = null
  for (const dp of DAYPART_RE) {
    if (dp.re.test(text)) { part = dp.part; break }
  }

  const dayOffset = DAY_AFTER_RE.test(text) ? 2 : TOMORROW_RE.test(text) ? 1 : 0

  // Precision gate: bare "৪টা / 4 ta" is ALSO the counting classifier ("৪টা
  // অর্ডার" = 4 orders). Treat it as a clock time only when something else
  // says "time": a টায়/টার/tay/tar suffix, :MM minutes, am/pm, সাড়ে/পৌনে/সোয়া,
  // a daypart word, or a day word.
  const strongAnchor =
    /টায়|টার|টাতে|tay|tate|tar/i.test(matched) || m[3] != null || ampm != null || half != null
  if (!strongAnchor && !part && dayOffset === 0) return null

  const dNow = dhakaParts(now)
  let due: Date
  if (hour12 > 12 || ampm) {
    // Explicit 24h ("16:00") or am/pm — no inference needed.
    let h24 = hour12
    if (ampm === 'pm' && hour12 < 12) h24 = hour12 + 12
    if (ampm === 'am' && hour12 === 12) h24 = 0
    due = fromDhaka(dNow.y, dNow.mo, dNow.day + dayOffset, h24, minute)
    if (dayOffset === 0 && due.getTime() <= now.getTime()) {
      due = fromDhaka(dNow.y, dNow.mo, dNow.day + 1, h24, minute)
    }
  } else if (part) {
    const h24 = hourTo24(hour12, part)
    due = fromDhaka(dNow.y, dNow.mo, dNow.day + dayOffset, h24, minute)
    if (dayOffset === 0 && due.getTime() <= now.getTime()) {
      due = fromDhaka(dNow.y, dNow.mo, dNow.day + 1, h24, minute)
    }
  } else if (dayOffset > 0) {
    // "কাল ৪টায়" with no daypart: waking-hours heuristic — 1-6 reads as
    // afternoon, 7-11 as morning, 12 as noon.
    const h24 = hour12 <= 6 ? hour12 + 12 : hour12 === 12 ? 12 : hour12
    due = fromDhaka(dNow.y, dNow.mo, dNow.day + dayOffset, h24, minute)
  } else {
    // No daypart, today: the NEXT future occurrence of that clock position.
    const cands = [
      fromDhaka(dNow.y, dNow.mo, dNow.day, hour12 % 12, minute),
      fromDhaka(dNow.y, dNow.mo, dNow.day, (hour12 % 12) + 12, minute),
      fromDhaka(dNow.y, dNow.mo, dNow.day + 1, hour12 % 12, minute),
      fromDhaka(dNow.y, dNow.mo, dNow.day + 1, (hour12 % 12) + 12, minute),
    ].filter((d) => d.getTime() > now.getTime())
    due = cands.sort((a, b) => a.getTime() - b.getTime())[0]
  }

  if (!due || due.getTime() <= now.getTime()) return null
  return { iso: toIsoDhaka(due), label: labelFor(due, now, part), matched }
}

/**
 * Reminder-to-Boss phrasings that pair with a time expression (Bangla + Banglish +
 * voice-transcript variants). Deliberately narrow — the time hint only helps when
 * the message is clearly a reminder request, never general chat about numbers.
 */
export const REMINDER_TIME_HINT_RE =
  /remind|রিমাইন্ডার|reminder|মনে করিয়ে|মনে করায়|অ্যালার্ম|এলার্ম|alarm|জাগিয়ে|jagiye|(?:call|কল|ফোন)\s*(?:দিও|দিয়ো|dio|diyo)/i

/**
 * Full deterministic intake directive for a reminder request with a resolvable
 * time — shared by BOTH head paths (core.ts native-Claude and
 * models/run-owner-turn.ts Gemini/alternate) so neither can drift. Returns null
 * when the message is not reminder-shaped or no confident time parsed.
 */
export function buildReminderTimeHintBlock(text: string, now = new Date()): string | null {
  if (!text || !REMINDER_TIME_HINT_RE.test(text)) return null
  const resolved = resolveBanglaTimeExpression(text, now)
  if (!resolved) return null
  return (
    '[REMINDER TIME — resolved deterministically]\n' +
    `Boss's phrase "${resolved.matched}" = ${resolved.iso} (Asia/Dhaka, ${resolved.label}). ` +
    'This is a reminder TO BOSS, not an outbound relay call to someone else. ' +
    `Call set_reminder NOW with dueAt="${resolved.iso}". ` +
    'If Boss asked to be CALLED (কল দিও/ফোন দিও/call dio) use tier 3 (phone-call reminder, confirm card); ' +
    'otherwise tier 1. Do NOT use outbound_phone_call or place_agent_call for this.'
  )
}
