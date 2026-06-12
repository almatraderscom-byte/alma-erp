/**
 * Default responses when owner taps a menu command without extra arguments.
 * Goal: menu tap → useful result + next-step buttons (no usage-only dead ends).
 */

import { handleDetailsCommand } from '../finance/index.mjs'
import {
  handleCatalogSuggest,
  handleCatalogStatus,
  catalogPanelKeyboard,
  showCatalogGuide,
} from './catalog.mjs'
import { replyMarkdownSafe } from './markdown-safe.mjs'

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

  await replyMarkdownSafe(
    ctx,
    `🤖 *কাস্টমার এজেন্ট*\n\n` +
      `মোড: *${mode}*\n` +
      `ফলো-আপ: *${followups}*\n\n` +
      `বাটন চাপুন — সাথে সাথে কাজ হবে:`,
    { reply_markup: csControlKeyboard() },
  )
}

export async function showCatalogPanel(ctx, { isOwner }) {
  await handleCatalogStatus(ctx, { replyMarkup: catalogPanelKeyboard(isOwner) })
}

export async function showStaffPanel(ctx, supabase) {
  const { data: rows } = await supabase
    .from('agent_staff')
    .select('name, role, telegram_chat_id, active')
    .order('name')

  const active = (rows ?? []).filter((r) => r.active !== false)
  let list = 'কোনো স্টাফ নেই।'
  if (active.length) {
    list = active.map((s) => {
      const linked = s.telegram_chat_id ? `✅ ${s.telegram_chat_id}` : '❌ লিঙ্ক নেই'
      return `• ${s.name} (${s.role}) — ${linked}`
    }).join('\n')
  }

  await replyMarkdownSafe(
    ctx,
    `👥 *স্টাফ তালিকা*\n\n${list}\n\n` +
      '*নতুন লিঙ্ক:*\n' +
      '`/staff link Eyafi 1234567890`\n\n' +
      'GPS গাইড: /staff_onboard',
  )
}

export async function showPostlinkPanel(ctx, supabase) {
  const { data: posts } = await supabase
    .from('cs_post_products')
    .select('post_id, product_codes, created_at')
    .order('created_at', { ascending: false })
    .limit(5)

  let recent = ''
  if (posts?.length) {
    recent = '\n\n*সাম্প্রতিক লিঙ্ক:*\n' + posts.map((p) => {
      const codes = Array.isArray(p.product_codes)
        ? p.product_codes.join(', ')
        : String(p.product_codes ?? '')
      return `• ${p.post_id} → ${codes || '—'}`
    }).join('\n')
  }

  await replyMarkdownSafe(
    ctx,
    '🔗 *FB পোস্ট লিঙ্ক*' + recent + '\n\n' +
      'নতুন লিঙ্ক:\n' +
      '`/postlink <পোস্ট ID বা URL> FM-204 FM-205`\n\n' +
      'উদাহরণ:\n' +
      '`/postlink 123456789012345 FM-204`',
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
    await replyMarkdownSafe(
      ctx,
      '💰 কোনো হিসাব নেই।\n\nনাম লিখে খুঁজুন:\n/details Hossain mama',
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

  await replyMarkdownSafe(
    ctx,
    '💰 *কার হিসাব দেখবেন?* — নাম চাপুন:\n\n' +
      'অথবা লিখুন: /details Hossain mama',
    { reply_markup: { inline_keyboard: keyboard } },
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

  await replyMarkdownSafe(
    ctx,
    '💬 *এজেন্টকে প্রশ্ন করুন*\n\n' +
      'নিচের উদাহরণ চাপুন অথবা লিখুন:\n' +
      '/ask আজ কত বিক্রি?',
    { reply_markup: { inline_keyboard: keyboard } },
  )
}

export function getAskExample(index) {
  return ASK_EXAMPLES[index] ?? null
}

export async function showPostlinkGuide(ctx, supabase) {
  await showPostlinkPanel(ctx, supabase)
}

export async function showStaffGuide(ctx, supabase) {
  await showStaffPanel(ctx, supabase)
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

  await replyMarkdownSafe(
    ctx,
    '👨‍👩‍👧‍👦 *ফ্যামিলি ডিজাইন গ্রুপ*' + list + '\n\n' +
      'নতুন গ্রুপ:\n' +
      '`/group FM-204 FM-205 Family Panjabi Eid`\n\n' +
      'রোল সেট:\n' +
      '`/group set FMG-001 FM-205 chele`',
    { reply_markup: { inline_keyboard: keyboard } },
  )
}

export async function showGroupHelp(ctx) {
  await replyMarkdownSafe(
    ctx,
    '👨‍👩‍👧‍👦 *গ্রুপ কমান্ড*\n\n' +
      'নতুন গ্রুপ:\n' +
      '`/group FM-204 FM-205 Family Panjabi Eid`\n\n' +
      'রোল সেট:\n' +
      '`/group set FMG-001 FM-205 chele`\n' +
      'অথবা\n' +
      '`/group set FM-205 chele`',
  )
}

export async function handleGroupSuggestCallback(ctx) {
  await ctx.answerCbQuery()
  await handleCatalogSuggest(ctx)
}
