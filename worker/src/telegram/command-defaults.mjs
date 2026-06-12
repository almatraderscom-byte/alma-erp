/**
 * Default responses when owner taps a menu command without extra arguments.
 * Goal: menu tap → useful result + next-step buttons (no usage-only dead ends).
 */

import { handleDetailsCommand } from '../finance/index.mjs'
import { handleCatalogSuggest } from './catalog.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

function csControlKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📋 Status', callback_data: 'menu:cs:status' },
        { text: '👁 Shadow', callback_data: 'menu:cs:shadow' },
        { text: '⚡ Auto', callback_data: 'menu:cs:auto' },
        { text: '⏹ বন্ধ', callback_data: 'menu:cs:off' },
      ],
      [
        { text: '🔔 Follow-ups চালু', callback_data: 'menu:cs:followups:on' },
        { text: '🔕 Follow-ups বন্ধ', callback_data: 'menu:cs:followups:off' },
      ],
    ],
  }
}

const ASK_EXAMPLES = [
  'আজ কত বিক্রি হয়েছে?',
  'আজ কোন টাস্ক বাকি আছে?',
  'এই মাসের মোট খরচ কত?',
  'কালকের সেলস রিপোর্ট দাও',
]

export async function showCsPanel(ctx) {
  const res = await fetch(
    `${APP_URL()}/api/assistant/internal/agent-settings?keys=cs_mode,cs_followups_enabled`,
    { headers: { Authorization: `Bearer ${INT_TOKEN()}` } },
  )
  const data = await res.json().catch(() => ({}))
  const mode = data.cs_mode ?? 'off'
  const followups = String(data.cs_followups_enabled ?? 'true') === 'true' ? 'চালু' : 'বন্ধ'

  await ctx.reply(
    `🤖 *কাস্টমার এজেন্ট*\n\n` +
      `মোড: *${mode}*\n` +
      `ফলো-আপ: *${followups}*\n\n` +
      `বাটন চাপুন — সাথে সাথে কাজ হবে:`,
    { parse_mode: 'Markdown', reply_markup: csControlKeyboard() },
  )
}

export async function showDetailsPicker(ctx, supabase) {
  const { data: rows } = await supabase
    .from('finance_ledger')
    .select('person_name')
    .order('person_name')

  const seen = new Set()
  const names = []
  for (const r of rows ?? []) {
    const n = r.person_name?.trim()
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(n)
  }

  if (!names.length) {
    await ctx.reply(
      '💰 কোনো হিসাব নেই।\n\n' +
        'নাম লিখে খুঁজুন:\n/details Hossain mama',
    )
    return
  }

  const pick = names.slice(0, 12)
  const keyboard = []
  for (let i = 0; i < pick.length; i += 2) {
    const row = [{ text: pick[i], callback_data: `details_pick:${i}` }]
    if (pick[i + 1]) row.push({ text: pick[i + 1], callback_data: `details_pick:${i + 1}` })
    keyboard.push(row)
  }

  await ctx.reply(
    '💰 *কার হিসাব দেখবেন?* — নাম চাপুন:\n\n' +
      'অথবা লিখুন: /details Hossain mama',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } },
  )
}

export async function handleDetailsPick(ctx, supabase, index) {
  const { data: rows } = await supabase
    .from('finance_ledger')
    .select('person_name')
    .order('person_name')

  const seen = new Set()
  const names = []
  for (const r of rows ?? []) {
    const n = r.person_name?.trim()
    if (!n) continue
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(n)
  }

  const name = names[index]
  if (!name) {
    await ctx.reply('নাম পাওয়া যায়নি — আবার /details চাপুন।')
    return
  }
  await handleDetailsCommand(ctx, name, supabase, 0)
}

export async function showAskPrompt(ctx) {
  const keyboard = ASK_EXAMPLES.map((q, i) => [{
    text: q.length > 36 ? `${q.slice(0, 34)}…` : q,
    callback_data: `ask_go:${i}`,
  }])

  await ctx.reply(
    '💬 *এজেন্টকে প্রশ্ন করুন*\n\n' +
      'নিচের উদাহরণ চাপুন অথবা লিখুন:\n' +
      '/ask আজ কত বিক্রি?',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } },
  )
}

export function getAskExample(index) {
  return ASK_EXAMPLES[index] ?? null
}

export async function showPostlinkGuide(ctx) {
  await ctx.reply(
    '🔗 *FB পোস্ট লিঙ্ক*\n\n' +
      'ফরম্যাট:\n' +
      '`/postlink <পোস্ট URL বা ID> FM-204 FM-205`\n\n' +
      'উদাহরণ:\n' +
      '`/postlink 123456789012345 FM-204`\n' +
      '`/postlink https://facebook.com/.../posts/123 FM-204 FM-205`\n\n' +
      'পোস্ট URL বা numeric post ID কপি করে পেস্ট করুন।',
    { parse_mode: 'Markdown' },
  )
}

export async function showStaffGuide(ctx) {
  await ctx.reply(
    '👥 *স্টাফ টেলিগ্রাম লিঙ্ক*\n\n' +
      '১. স্টাফকে বটে /start করতে বলুন\n' +
      '২. তাদের Chat ID নোট করুন (বট দেখাবে)\n' +
      '৩. লিঙ্ক করুন:\n' +
      '`/staff link Eyafi 1234567890`\n\n' +
      'GPS অনবোর্ডিং গাইড: /staff_onboard',
    { parse_mode: 'Markdown' },
  )
}

export async function showGroupPanel(ctx, { isOwner, supabase }) {
  const { data: groups } = await supabase
    .from('cs_design_groups')
    .select('group_code, title')
    .order('created_at', { ascending: false })
    .limit(10)

  let list = ''
  if (groups?.length) {
    list = '\n\n*সাম্প্রতিক গ্রুপ:*\n' +
      groups.map((g) => `• *${g.group_code}* — ${g.title ?? '—'}`).join('\n')
  }

  const keyboard = []
  if (isOwner) {
    keyboard.push([{ text: '💡 গ্রুপ সাজেস্ট', callback_data: 'group:suggest' }])
  }
  keyboard.push([{ text: '📖 ব্যবহারের উদাহরণ', callback_data: 'group:help' }])

  await ctx.reply(
    '👨‍👩‍👧‍👦 *ফ্যামিলি ডিজাইন গ্রুপ*' + list + '\n\n' +
      'নতুন গ্রুপ:\n' +
      '`/group FM-204 FM-205 Family Panjabi Eid`\n\n' +
      'রোল সেট:\n' +
      '`/group set FMG-001 FM-205 chele`',
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } },
  )
}

export async function showGroupHelp(ctx) {
  await ctx.reply(
    '👨‍👩‍👧‍👦 *গ্রুপ কমান্ড*\n\n' +
      'নতুন গ্রুপ:\n' +
      '`/group FM-204 FM-205 Family Panjabi Eid`\n\n' +
      'রোল সেট:\n' +
      '`/group set FMG-001 FM-205 chele`\n' +
      'অথবা\n' +
      '`/group set FM-205 chele`',
    { parse_mode: 'Markdown' },
  )
}

export async function handleGroupSuggestCallback(ctx) {
  await ctx.answerCbQuery()
  await handleCatalogSuggest(ctx)
}
