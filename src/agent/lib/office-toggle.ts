/**
 * Point 3 (Part A) — owner-declared "no office today" toggle.
 *
 * When the owner says office is off today, the agent immediately suspends ALL office
 * duties (the day-shift tick/start checks `office_off:<ymd>`), then politely asks the
 * reason for its own record. If the reason looks like a passing whim, the agent may
 * suggest ONCE that the office could still be touched — but the 2nd time the owner's
 * word is final. The owner can also turn the office back on the same day.
 *
 * Mirrors the owner-task-intake ask→await-reply→act pattern: a KV "pending" marker holds
 * the conversation stage; the first owner reply while pending is captured in core.ts.
 */
import { prisma } from '@/lib/prisma'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { getOrCreateDayShiftConversation, appendShiftNarrative } from '@/agent/lib/day-shift'
import { missReasonKey } from '@/agent/lib/yesterday-accounting'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'

const BUSINESS_ID = 'ALMA_LIFESTYLE'

export function officeOffKey(ymd: string): string {
  return `office_off:${ymd}`
}

function officeOffPendingKey(ymd: string): string {
  return `office_off_pending:${ymd}`
}

/** Owner declaring the office is closed/off today. Conservative to avoid false hits. */
const OFFICE_OFF_PATTERN =
  /(অফিস|অফিসটা|office)\s*(আজ\s*)?(বন্ধ|বন্‌ধ|নেই|হবে\s*না|off|bondho|bondo|band|nei|nai|chuti|ছুটি|close|closed|hobe\s*na)|(আজ|aj|ajke|আজকে|today)\s*(অফিস\s*)?(ছুটি|chuti|বন্ধ|bondho|off|নেই|nei)/i

/** Re-open the office the same day after declaring it off. */
const OFFICE_ON_PATTERN =
  /(অফিস|office)\s*(আবার|abar|abr|আবার)?\s*(চালু|খোলা|খুলে|on|chalu|cholbe|choluk|khola|khulo|khol|start|back)|office\s*on/i

/** Reason that reads like a passing whim rather than a real cause (suggest once). */
const WHIM_PATTERN =
  /এমনি|emni|emnitei|ইচ্ছা\s*করছে\s*না|iccha\s*korche\s*na|mon\s*chaiche\s*na|মন\s*চাইছে\s*না|mood\s*nei|ভাল্লাগছে\s*না|valo\s*lagche\s*na|bhalo\s*lagche\s*na|আলসেমি|alsemi|alsi|alse|ঘুম|ghum|ও?ভাবেই|just|emnei/i

/** Owner, at the suggestion stage, choosing to keep the office open after all. */
const KEEP_OPEN_PATTERN =
  /কাজ\s*কর|kaj\s*kor|খোলা\s*রাখ|khola\s*rakh|চালু\s*রাখ|chalu\s*rakh|choluk|চলুক|thik\s*ache.*kor|ঠিক\s*আছে.*কর|হ্যাঁ\s*কর|hae\s*kor|na\s*thak|না\s*থাক/i

/** Owner explicitly confirming "yes, close the whole office today". */
const CONFIRM_OFF_PATTERN =
  /হ্যাঁ|হ্যা\b|হু\b|hae|han\b|ha\b|hu\b|yes|confirm|নিশ্চিত|nishchit|nischit|বন্ধই?\s*রাখ|bondhoi?\s*rakh|বন্ধ\s*কর|bondho\s*kor|off\s*kore?\s*da|বন্ধ\s*করে?\s*দা/i

/** Owner backing out of the close confirmation — keep the office open. */
const CANCEL_OFF_PATTERN =
  /না\b|না,|nah?\b|thak|থাক|বাদ\s*দা|bad\s*da|cancel|বাতিল|batil|ভুল|bhul|vul|chalu\s*rakh|চালু\s*রাখ|খোলা\s*রাখ|khola\s*rakh|kaj\s*hobe|কাজ\s*হবে/i

/** Owner talking about his OWN absence ("আমি আজ অফিসে নেই/যাবো না") — NOT a request to
 *  shut the office for staff. Guards against false full-day shutdowns. */
const SELF_ABSENCE_PATTERN =
  /(আমি|ami|amar|আমার)\b[^।.!?]*?(অফিস|office)?[^।.!?]*?(যাব\s*না|jabo\s*na|আসব\s*না|asbo\s*na|থাকব\s*না|thakbo\s*na|নেই|nei|nai|absent|late|দেরি|deri)/i

export function detectOfficeOffDeclaration(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  // Don't capture staff-leave management ("রহিমের ছুটি approve করো").
  if (/approve|approv|staff|স্টাফ|কর্মচারী/i.test(t) && !/অফিস|office/i.test(t)) return false
  // Don't confuse the owner's own absence with an office-wide closure.
  if (SELF_ABSENCE_PATTERN.test(t) && !/(সবাই|সকল|সব\s*স্টাফ|all\s*staff|everyone|office\s*bondho|অফিস\s*বন্ধ|ছুটি\s*দা|chuti\s*da)/i.test(t)) return false
  return OFFICE_OFF_PATTERN.test(t)
}

export function detectOfficeOnDeclaration(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return OFFICE_ON_PATTERN.test(t)
}

async function readKv(key: string): Promise<string | null> {
  const row = await prisma.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
  return row?.value ?? null
}

export async function isOfficeOffToday(today = todayYmdDhaka()): Promise<boolean> {
  return Boolean(await readKv(officeOffKey(today)))
}

type OffPending = { stage: 'awaiting_confirm' | 'awaiting_reason' | 'suggested'; declaredAt: string }

async function getPendingOff(today: string): Promise<OffPending | null> {
  const raw = await readKv(officeOffPendingKey(today))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<OffPending>
    if (parsed.stage === 'awaiting_confirm' || parsed.stage === 'awaiting_reason' || parsed.stage === 'suggested') {
      return { stage: parsed.stage, declaredAt: parsed.declaredAt ?? new Date().toISOString() }
    }
  } catch {
    /* fall through */
  }
  return null
}

async function setOfficeOff(today: string, reason?: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: officeOffKey(today) },
    create: {
      key: officeOffKey(today),
      value: JSON.stringify({ date: today, reason: reason ?? null, declaredAt: new Date().toISOString() }),
    },
    update: { value: JSON.stringify({ date: today, reason: reason ?? null, declaredAt: new Date().toISOString() }) },
  })
}

async function setPending(today: string, stage: OffPending['stage']): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: officeOffPendingKey(today) },
    create: { key: officeOffPendingKey(today), value: JSON.stringify({ stage, declaredAt: new Date().toISOString() }) },
    update: { value: JSON.stringify({ stage, declaredAt: new Date().toISOString() }) },
  })
}

async function clearPending(today: string): Promise<void> {
  await prisma.agentKvSetting.deleteMany({ where: { key: officeOffPendingKey(today) } })
}

async function clearOfficeOff(today: string): Promise<void> {
  await prisma.agentKvSetting.deleteMany({
    where: { key: { in: [officeOffKey(today), officeOffPendingKey(today)] } },
  })
}

/** Record the off-day reason so the weekly review picks it up (same key as Point 2). */
async function recordOffReason(today: string, reason: string): Promise<void> {
  await setOfficeOff(today, reason)
  await prisma.agentKvSetting.upsert({
    where: { key: missReasonKey(today) },
    create: {
      key: missReasonKey(today),
      value: JSON.stringify({ date: today, reason: `অফিস বন্ধ (owner): ${reason}`, recordedAt: new Date().toISOString() }),
    },
    update: {
      value: JSON.stringify({ date: today, reason: `অফিস বন্ধ (owner): ${reason}`, recordedAt: new Date().toISOString() }),
    },
  })
  try {
    await createOrUpdateAgentMemory({
      scope: 'business',
      key: `office_off_reason:${today}`,
      content: `${today} তারিখে owner অফিস বন্ধ ঘোষণা করেছেন। কারণ: ${reason}`,
      metadata: { type: 'office_off_reason', date: today, businessId: BUSINESS_ID },
      importance: 3,
    })
  } catch (err) {
    console.warn('[office-toggle] memory save failed:', err instanceof Error ? err.message : err)
  }
}

async function narrate(today: string, text: string): Promise<void> {
  try {
    const conversationId = await getOrCreateDayShiftConversation(today)
    await appendShiftNarrative(conversationId, text)
  } catch {
    /* office chat narration is best-effort */
  }
}

export type OfficeToggleResult = { autoReply?: string }

/**
 * Capture an owner office on/off declaration or the reply to the "why off?" question.
 * Returns an autoReply (short-circuits the LLM turn) or null when not relevant.
 */
export async function processOfficeToggleReply(
  text: string,
  _conversationId?: string,
): Promise<OfficeToggleResult | null> {
  const today = todayYmdDhaka()
  const trimmed = text.trim()
  if (!trimmed) return null

  const pending = await getPendingOff(today)

  // Stage 1.5: owner is replying to "are you sure you want the office closed today?"
  // Nothing is suspended yet — we only suspend on an explicit confirmation.
  if (pending?.stage === 'awaiting_confirm') {
    if (CONFIRM_OFF_PATTERN.test(trimmed) && !CANCEL_OFF_PATTERN.test(trimmed)) {
      await setOfficeOff(today)
      await setPending(today, 'awaiting_reason')
      await narrate(today, '🛑 Boss নিশ্চিত করলেন — আজকের সব অফিস duty থামিয়ে দিলাম।')
      return {
        autoReply:
          'ঠিক আছে Boss, আজকের সব অফিস ডিউটি বন্ধ রাখলাম। একটু জানতে পারি — আজ কেন অফিস বন্ধ? (শুধু আমার রেকর্ডের জন্য)',
      }
    }
    // Anything that is not a clear "yes" → keep the office open (fail-safe).
    await clearPending(today)
    await narrate(today, '✅ অফিস চালু রইলো — duty স্বাভাবিকভাবে চলবে।')
    return {
      autoReply: 'ঠিক আছে Boss, তাহলে অফিস চালু রাখলাম — আজকের কাজ স্বাভাবিকভাবে চলবে ইনশাআল্লাহ।',
    }
  }

  // Stage 2/3: owner is replying to "why is the office off today?"
  if (pending) {
    const reason = trimmed.slice(0, 500)

    if (pending.stage === 'suggested') {
      // Owner's word is final — but honor a last-moment decision to keep it open.
      if (detectOfficeOnDeclaration(trimmed) || KEEP_OPEN_PATTERN.test(trimmed)) {
        await clearOfficeOff(today)
        await narrate(today, '✅ Boss অফিস চালু রাখলেন — duty আবার শুরু করছি।')
        return { autoReply: 'জি Boss, তাহলে অফিস চালু রাখছি — ইনশাআল্লাহ শুরু করছি।' }
      }
      await recordOffReason(today, reason)
      await clearPending(today)
      return {
        autoReply:
          'ঠিক আছে Boss, আপনার সিদ্ধান্তই চূড়ান্ত — আজ অফিস বন্ধ রাখলাম। বিশ্রাম নিন, কাল ইনশাআল্লাহ আবার শুরু করবো। 🤲',
      }
    }

    // stage === 'awaiting_reason' — but an "office on / keep open" reply must RE-OPEN,
    // never be mistaken for a closure reason (this was the bug: "office on thakbe" got
    // recorded as the reason and the office stayed shut all day).
    if (detectOfficeOnDeclaration(trimmed) || KEEP_OPEN_PATTERN.test(trimmed)) {
      await clearOfficeOff(today)
      await narrate(today, '✅ Boss অফিস চালু রাখলেন — duty আবার শুরু করছি।')
      return { autoReply: 'আলহামদুলিল্লাহ Boss, অফিস চালু রাখলাম — আজকের duty শুরু করছি ইনশাআল্লাহ।' }
    }
    await recordOffReason(today, reason)
    if (WHIM_PATTERN.test(reason)) {
      await setPending(today, 'suggested')
      return {
        autoReply:
          'বুঝলাম Boss। তবে চাইলে হালকা কিছু কাজ দিয়ে হলেও অফিসটা একটু ছোঁয়া যেত — তবে সিদ্ধান্ত পুরোপুরি আপনার। ' +
          'বলুন, আজ বন্ধই রাখবো নাকি চালু করবো?',
      }
    }
    await clearPending(today)
    return {
      autoReply: 'ঠিক আছে Boss, কারণটা বুঝলাম — আজ অফিস বন্ধ রাখলাম। বিশ্রাম নিন, কাল আবার শুরু করবো ইনশাআল্লাহ। 🤲',
    }
  }

  // Owner re-opening the office the same day.
  if (await isOfficeOffToday(today)) {
    if (detectOfficeOnDeclaration(trimmed)) {
      await clearOfficeOff(today)
      await narrate(today, '✅ Boss অফিস আবার চালু করলেন — duty শুরু করছি।')
      return { autoReply: 'আলহামদুলিল্লাহ Boss, অফিস আবার চালু করলাম — আজকের duty শুরু করছি ইনশাআল্লাহ।' }
    }
    return null
  }

  // New "no office today" declaration → DO NOT suspend yet. Confirm first, because a
  // single ambiguous message must never silently shut the whole business day.
  if (detectOfficeOffDeclaration(trimmed)) {
    await setPending(today, 'awaiting_confirm')
    return {
      autoReply:
        'Boss, একটু নিশ্চিত করি — আজ কি পুরো অফিস বন্ধ রাখবো? তাহলে আজকের সব স্টাফ duty থেমে যাবে। ' +
        '"হ্যাঁ" বললে বন্ধ করছি, নাহলে স্বাভাবিকভাবে কাজ চলবে।',
    }
  }

  return null
}
