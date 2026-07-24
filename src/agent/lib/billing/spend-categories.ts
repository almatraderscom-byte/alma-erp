/**
 * Owner-facing spend categories — "where did today's money go, by activity".
 *
 * Every cost event maps to exactly ONE category via (kind, provider, source), so
 * the category totals always sum back to the grand total (an `other` catch-all
 * absorbs anything unmapped). This is what lets the owner reconcile the daily
 * budget at a glance: Σ categories == day total, and the chat headline is a named
 * subset he can match against his own chat usage.
 *
 * Classification uses `kind` + `provider` (reliable, from pricing.ts CostKind) and
 * the conversation `source` (to split owner chat from background/automated work).
 * It deliberately does NOT rely on `units.purpose`, which is tagged inconsistently
 * across emitters.
 */

export type SpendCategoryId =
  | 'owner_chat'
  | 'background_agent'
  | 'live_voice'
  | 'phone_call'
  | 'voice_message'
  | 'voice_input'
  | 'image'
  | 'video'
  | 'customer_service'
  | 'quality_check'
  | 'research'
  | 'memory'
  | 'other'

export type SpendCategoryMeta = {
  id: SpendCategoryId
  label: string
  icon: string
  /** One-line owner-facing explanation of what falls in this bucket. */
  hint: string
  /** True for the buckets the owner most wants at the top of the glance. */
  headline?: boolean
}

/**
 * Conversation sources that count as the owner talking to the agent directly
 * (web app, owner session, iOS app, and the owner's Hermes Telegram bot).
 * Everything else — server jobs, day-shift, rotations, heartbeat — is background.
 */
export const OWNER_CHAT_SOURCES: ReadonlySet<string> = new Set([
  'web', 'owner', 'ios', 'telegram', 'app', 'owner_teaching',
])

/** Display order + metadata. Also the canonical category list. */
export const SPEND_CATEGORY_META: readonly SpendCategoryMeta[] = [
  { id: 'owner_chat', label: 'চ্যাট (Boss)', icon: '💬', hint: 'Boss-এর সাথে সরাসরি চ্যাট (web / app / Telegram)', headline: true },
  { id: 'live_voice', label: 'লাইভ ভয়েস কল', icon: '🎙️', hint: 'অ্যাপে সরাসরি ভয়েস-টু-ভয়েস কল (Gemini Live)', headline: true },
  { id: 'phone_call', label: 'ফোন কল', icon: '📞', hint: 'Twilio দিয়ে বাইরে ফোন কল + কল ভয়েস', headline: true },
  { id: 'background_agent', label: 'ব্যাকগ্রাউন্ড এজেন্ট', icon: '🤖', hint: 'নিজে নিজে চলা কাজ (rotation, day-shift, server job)', headline: true },
  { id: 'image', label: 'ইমেজ তৈরি', icon: '🖼️', hint: 'ছবি জেনারেশন (Nano Banana / fal / FASHN)' },
  { id: 'video', label: 'ভিডিও তৈরি', icon: '🎬', hint: 'ভিডিও জেনারেশন (Veo)' },
  { id: 'voice_message', label: 'ভয়েস রিপ্লাই', icon: '🔊', hint: 'TTS ভয়েস মেসেজ / বলা উত্তর' },
  { id: 'voice_input', label: 'ভয়েস ইনপুট', icon: '🎧', hint: 'ভয়েস শুনে টেক্সট (transcribe)' },
  { id: 'customer_service', label: 'কাস্টমার সার্ভিস', icon: '🛎️', hint: 'CS চ্যাট + ছবি বোঝা + কমেন্ট classify' },
  { id: 'quality_check', label: 'কোয়ালিটি চেক', icon: '✅', hint: 'প্রোডাক্ট ছবি QC (vision)' },
  { id: 'research', label: 'রিসার্চ / স্ক্র্যাপ', icon: '🔎', hint: 'ওয়েব রিসার্চ + স্ক্র্যাপিং (Oxylabs)' },
  { id: 'memory', label: 'মেমরি / এম্বেডিং', icon: '🧠', hint: 'RAG এম্বেডিং + মেমরি ইনডেক্স' },
  { id: 'other', label: 'অন্যান্য', icon: '•', hint: 'বাকি সব — যাতে মোট মিলে যায়' },
]

const META_BY_ID = new Map<SpendCategoryId, SpendCategoryMeta>(SPEND_CATEGORY_META.map((m) => [m.id, m]))

export function spendCategoryMeta(id: SpendCategoryId): SpendCategoryMeta {
  return META_BY_ID.get(id) ?? META_BY_ID.get('other')!
}

export type SpendClassifierInput = {
  kind: string
  /** Effective provider (gemini/twilio/anthropic/...). */
  provider: string
  /** Conversation source, when the event is tied to a conversation. */
  source?: string | null
}

/** Map one cost event to exactly one owner-facing category. Total function. */
export function classifySpend(input: SpendClassifierInput): SpendCategoryId {
  const kind = (input.kind || '').toLowerCase()
  const provider = (input.provider || '').toLowerCase()

  switch (kind) {
    case 'chat':
      return input.source && OWNER_CHAT_SOURCES.has(input.source) ? 'owner_chat' : 'background_agent'
    case 'call':
      // Live in-app voice-to-voice runs on Gemini Live; outbound phone runs on Twilio.
      return provider === 'gemini' ? 'live_voice' : 'phone_call'
    case 'tts':
      return 'voice_message'
    case 'transcribe':
      return 'voice_input'
    case 'image':
      return 'image'
    case 'video':
      return 'video'
    case 'cs_chat':
    case 'cs_vision':
    case 'cs_comment_classify':
      return 'customer_service'
    case 'qc_vision':
      return 'quality_check'
    case 'web_research':
      return 'research'
    case 'embedding':
      return 'memory'
    default:
      return 'other'
  }
}

/** One grouped row of spend from the DB (kind × provider × source). */
export type SpendGroupRow = {
  kind: string
  provider: string
  source?: string | null
  usd: number
  count: number
}

export type SpendCategoryTotal = {
  id: SpendCategoryId
  label: string
  icon: string
  hint: string
  headline: boolean
  usd: number
  count: number
  /** Share of the grand total, 0–100, rounded to 1 dp. */
  pct: number
}

export type SpendBreakdown = {
  totalUsd: number
  categories: SpendCategoryTotal[]
  /** The owner's chat headline — direct Boss chat spend. */
  chatHeadlineUsd: number
  /** Σ categories, used to assert reconciliation against totalUsd. */
  reconciledUsd: number
  reconciled: boolean
}

function roundUsd6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000
}

/**
 * Fold grouped spend rows into an ordered, reconciled category breakdown.
 * Categories with zero spend are omitted (except never — we simply drop empties).
 * `reconciled` is true when Σ categories equals the summed input within a cent.
 */
export function buildSpendBreakdown(rows: SpendGroupRow[]): SpendBreakdown {
  const byCat = new Map<SpendCategoryId, { usd: number; count: number }>()
  let total = 0
  for (const row of rows) {
    const usd = Number.isFinite(row.usd) ? row.usd : 0
    const count = Number.isFinite(row.count) ? row.count : 0
    total += usd
    const id = classifySpend(row)
    const acc = byCat.get(id) ?? { usd: 0, count: 0 }
    acc.usd += usd
    acc.count += count
    byCat.set(id, acc)
  }
  total = roundUsd6(total)

  const categories: SpendCategoryTotal[] = []
  for (const meta of SPEND_CATEGORY_META) {
    const acc = byCat.get(meta.id)
    if (!acc || acc.usd <= 0) continue
    categories.push({
      id: meta.id,
      label: meta.label,
      icon: meta.icon,
      hint: meta.hint,
      headline: Boolean(meta.headline),
      usd: roundUsd6(acc.usd),
      count: acc.count,
      pct: total > 0 ? Math.round((acc.usd / total) * 1000) / 10 : 0,
    })
  }
  categories.sort((a, b) => b.usd - a.usd)

  const reconciledUsd = roundUsd6(categories.reduce((s, c) => s + c.usd, 0))
  const chatHeadlineUsd = roundUsd6(byCat.get('owner_chat')?.usd ?? 0)

  return {
    totalUsd: total,
    categories,
    chatHeadlineUsd,
    reconciledUsd,
    reconciled: Math.abs(reconciledUsd - total) < 0.01,
  }
}
