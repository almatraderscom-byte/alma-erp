/**
 * Weekly strategic review via Anthropic Batch API (50% cost).
 * Prompts kept in sync with src/lib/weekly-strategic-data.ts narrateWeeklyStrategic().
 */
import { runBatch } from './batch-claude.mjs'
import { logCost, calcAnthropicChatCostUsd } from '../cost-log.mjs'

const AGENT_MODEL = 'claude-sonnet-4-6'
const SYSTEM =
  'ALMA weekly analyst. Bangla Telegram markdown. Use ONLY provided numbers; correlation not causation; include misses. All 4 sections required.'

function buildUserMessage(data) {
  const factsJson = JSON.stringify(data, null, 0).slice(0, 14000)
  return (
    'আপনি ALMA Lifestyle-এর সিনিয়র বিজনেস অ্যানালিস্ট। নিচের REAL ডেটা থেকে সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ লিখুন — শুধু বাংলায়, Telegram markdown (*bold*).\n\n' +
    'ফরম্যাট (সব ৪টি সেকশন অবশ্যই শেষ করুন):\n' +
    '📊 *সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ*\n' +
    'বিজনেস altitude (WoW সেল, টপ/বটম, রিটার্ন, নতুন vs রিপিট, ad spend যদি থাকে)\n' +
    'বাড়ছে / আটকে — ২-৩ clearest mover + সম্ভাব্য driver\n' +
    '🤖 আমার নিজের রিভিউ: পরামর্শ সংখ্যা, acceptance rate, outcome counts, ভুল (misses) স্পষ্টভাবে, কী adjust করব\n' +
    '🎯 আগামী সপ্তাহের ফোকাস: ২-৩ concrete data-backed priority\n\n' +
    'নিয়ম:\n' +
    '- শুধু দেওয়া সংখ্যা ব্যবহার করুন; অনুমান করবেন না।\n' +
    '- Misses অবশ্যই উল্লেখ করুন — শুধু win দেখাবেন না।\n' +
    '- Causation দাবি করবেন না; correlation ভাষা।\n' +
    '- সংক্ষিপ্ত রাখুন কিন্তু ৪টি সেকশন incomplete রেখে শেষ করবেন না।\n\n' +
    `DATA:\n${factsJson}`
  )
}

function selfReviewSection(data) {
  const sr = data.selfReview
  const lines = [
    '🤖 *আমার নিজের রিভিউ:*',
    `• এই সপ্তাহে ${sr.suggestionsMade}টি পরামর্শ — approve ${sr.approved}, reject ${sr.rejected}${sr.stillPending ? `, pending ${sr.stillPending}` : ''}${sr.acceptanceRatePct != null ? ` (acceptance ${sr.acceptanceRatePct}%)` : ''}।`,
    `• ফলাফল: ${sr.outcomes.worked} worked, ${sr.outcomes.noEffect} no-effect, ${sr.outcomes.worse} worse, ${sr.outcomes.stillMeasuring} measuring।`,
  ]
  if (sr.misses?.length) {
    for (const m of sr.misses.slice(0, 2)) {
      lines.push(`• ভুল: "${String(m.suggestion).slice(0, 60)}" — ${m.learning}`)
    }
  } else if (!sr.suggestionsMade) {
    lines.push('• এখনো পর্যাপ্ত outcome data নেই — পরামর্শ track শুরু হয়েছে।')
  } else {
    lines.push('• এখনো পরিমাপ matured হয়নি — সতর্ক থাকব।')
  }
  return lines.join('\n')
}

function focusSection(data) {
  if (!data.focusCandidates?.length) {
    return '🎯 *আগামী সপ্তাহের ফোকাস:*\n• ডেটা থেকে স্পষ্ট priority এখনো কম — সেল ট্রেন্ড মনিটর করুন।'
  }
  const lines = ['🎯 *আগামী সপ্তাহের ফোকাস:*']
  data.focusCandidates.forEach((f, i) => lines.push(`${i + 1}. ${f.action} — ${f.reason}`))
  return lines.join('\n')
}

function ensureCompleteNarrative(text, data) {
  let out = text.trim()
  if (!/নিজের রিভিউ|আমার নিজের|🤖/i.test(out)) {
    out += `\n\n${selfReviewSection(data)}`
  }
  if (!/আগামী সপ্তাহের ফোকাস|🎯/i.test(out)) {
    out += `\n\n${focusSection(data)}`
  }
  return out
}

function fallbackMessage(data) {
  const b = data.business
  const wow = b.wowRevenuePct != null ? `${b.wowRevenuePct > 0 ? '+' : ''}${b.wowRevenuePct}%` : '—'
  const sr = data.selfReview
  const lines = [
    '📊 *সাপ্তাহিক স্ট্র্যাটেজিক রিভিউ*',
    '',
    `*বিজনেস:* সেল গত সপ্তাহের তুলনায় ${wow} (৳${b.thisWeekRevenue} vs ৳${b.priorWeekRevenue})। অর্ডার: ${b.thisWeekOrders}। রিটার্ন: ${b.thisWeekReturnRatePct ?? '—'}%।`,
    '',
    selfReviewSection(data),
    '',
    focusSection(data),
  ]
  if (data.movers?.growing?.length) {
    lines.splice(3, 0, `*বাড়ছে:* ${data.movers.growing.map((g) => `${g.name} (${g.changePct ?? '—'}%)`).join(', ')}`)
  }
  return lines.join('\n')
}

async function fetchStrategicData(appUrl, intToken) {
  const res = await fetch(`${appUrl}/api/assistant/internal/weekly-strategic-data`, {
    headers: { Authorization: `Bearer ${intToken}` },
  })
  if (!res.ok) throw new Error(`weekly-strategic-data HTTP ${res.status}`)
  const json = await res.json()
  if (!json?.data) throw new Error('weekly-strategic-data missing data')
  return json.data
}

/**
 * @param {{ appUrl: string, intToken: string }} ctx
 * @returns {Promise<string|null>}
 */
export async function runWeeklyStrategicBatch({ appUrl, intToken }) {
  const data = await fetchStrategicData(appUrl, intToken)

  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.warn('[weekly-strategic-batch] ANTHROPIC_API_KEY missing — fallback text')
    return fallbackMessage(data)
  }

  const customId = 'weekly-strategic'
  const results = await runBatch([
    {
      custom_id: customId,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildUserMessage(data) }],
      max_tokens: 900,
    },
  ])

  const row = results.get(customId)
  if (!row?.text) {
    throw new Error(row?.error ? `batch failed: ${row.error}` : 'batch empty result')
  }

  const usage = row.usage ?? {}
  const costUsd = calcAnthropicChatCostUsd(
    {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
    },
    { batch: true },
  )

  void logCost({
    provider: 'anthropic',
    kind: 'chat',
    units: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      model: AGENT_MODEL,
      purpose: 'weekly_strategic',
      batch: 'true',
    },
    costUsd,
    dedupKey: `weekly-strategic:${data.period?.thisWeekEnd ?? 'unknown'}`,
  })

  const text = row.text.trim()
  return text ? ensureCompleteNarrative(text, data) : fallbackMessage(data)
}

/** Sync fallback via existing Vercel route (standard pricing, logged server-side). */
export async function runWeeklyStrategicSync({ appUrl, intToken }) {
  const res = await fetch(`${appUrl}/api/assistant/internal/weekly-strategic`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${intToken}` },
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`weekly-strategic sync HTTP ${res.status}`)
  return json.message ?? null
}
