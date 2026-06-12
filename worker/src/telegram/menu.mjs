/**
 * /menu — owner control panel (inline keyboard).
 * Buttons reuse existing command handlers — no duplicate business logic.
 */

import {
  handleTodayCommand,
  handleKhorochCommand,
  handleSalahTodayCommand,
} from './quick-commands.mjs'
import { handlePawnaCommand } from '../finance/index.mjs'
import { handleCatalogStatus } from './catalog.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export function menuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📊 আজকের রিপোর্ট', callback_data: 'menu:today' },
        { text: '💸 খরচ', callback_data: 'menu:khoroch' },
        { text: '🤝 পাওনা-দেনা', callback_data: 'menu:pawna' },
      ],
      [
        { text: '📋 CS Status', callback_data: 'menu:cs:status' },
        { text: '👁 Shadow', callback_data: 'menu:cs:shadow' },
        { text: '⚡ Auto', callback_data: 'menu:cs:auto' },
        { text: '⏹ বন্ধ', callback_data: 'menu:cs:off' },
      ],
      [
        { text: '🕌 আজকের নামাজ', callback_data: 'menu:salah:status' },
        { text: '⏸ ট্র্যাকিং Pause', callback_data: 'menu:salah:pause' },
      ],
      [
        { text: '⏰ রিমাইন্ডার তালিকা', callback_data: 'menu:reminder:list' },
        { text: '🔕 সব বন্ধ আজ', callback_data: 'menu:reminder:mute' },
      ],
      [
        { text: '📦 ক্যাটালগ Status', callback_data: 'menu:catalog:status' },
      ],
      [
        { text: '⚙️ Scheduler', callback_data: 'menu:sys:scheduler' },
        { text: '💚 Worker health', callback_data: 'menu:sys:health' },
      ],
      [
        { text: '📒 বিস্তারিত হিসাব', callback_data: 'menu:details' },
      ],
    ],
  }
}

export async function showMenuPanel(ctx) {
  await ctx.reply('🎛️ *কন্ট্রোল প্যানেল* — বাটন চাপুন:', {
    parse_mode: 'Markdown',
    reply_markup: menuKeyboard(),
  })
}

async function fetchInternal(path) {
  const res = await fetch(`${APP_URL()}${path}`, {
    headers: { Authorization: `Bearer ${INT_TOKEN()}` },
  })
  if (!res.ok) return null
  return res.json()
}

async function postSetting(key, value) {
  await fetch(`${APP_URL()}/api/assistant/internal/agent-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN()}` },
    body: JSON.stringify({ key, value }),
  })
}

export async function handleMenuCallback(ctx, action, deps) {
  const {
    supabase,
    handleCsStatus,
    handleCsModeCommand,
  } = deps

  await ctx.answerCbQuery()

  switch (action) {
    case 'today':
      return handleTodayCommand(ctx, supabase)
    case 'khoroch':
      return handleKhorochCommand(ctx, supabase)
    case 'pawna':
      return handlePawnaCommand(ctx, supabase)
    case 'details':
      return ctx.reply('নাম লিখুন:\n/details Hossain mama')
    case 'cs:status':
      return handleCsStatus(ctx)
    case 'cs:shadow':
      return handleCsModeCommand(ctx, 'shadow')
    case 'cs:auto':
      return handleCsModeCommand(ctx, 'auto')
    case 'cs:off':
      return handleCsModeCommand(ctx, 'off')
    case 'salah:status':
      return handleSalahTodayCommand(ctx, supabase)
    case 'salah:pause': {
      const settings = await fetchInternal('/api/assistant/internal/agent-settings?keys=salah_escalation_level')
      const current = String(settings?.salah_escalation_level ?? '2')
      const next = current === '0' ? '2' : '0'
      await postSetting('salah_escalation_level', next)
      const label = next === '0' ? 'বন্ধ (Pause)' : 'চালু (Level 2)'
      return ctx.reply(`🕌 সালাত ট্র্যাকিং এসকেলেশন: *${label}*`, { parse_mode: 'Markdown' })
    }
    case 'reminder:list': {
      const { data: rows } = await supabase
        .from('agent_reminders')
        .select('id, title, status, due_at')
        .in('status', ['pending', 'sent', 'snoozed'])
        .order('due_at', { ascending: true })
        .limit(15)
      if (!rows?.length) {
        return ctx.reply('⏰ কোনো সক্রিয় রিমাইন্ডার নেই।')
      }
      const lines = rows.map((r) => {
        const due = r.due_at ? new Date(r.due_at).toLocaleString('bn-BD', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' }) : '—'
        return `• ${r.title} (${r.status}) — ${due}`
      }).join('\n')
      return ctx.reply(`⏰ *রিমাইন্ডার*\n\n${lines}`, { parse_mode: 'Markdown' })
    }
    case 'reminder:mute': {
      const end = new Date(`${dhakaToday()}T23:59:59+06:00`)
      const minutes = Math.max(30, Math.ceil((end.getTime() - Date.now()) / 60_000))
      const { data: rows } = await supabase
        .from('agent_reminders')
        .select('id')
        .in('status', ['pending', 'sent'])
      let n = 0
      for (const r of rows ?? []) {
        const res = await fetch(`${APP_URL()}/api/assistant/internal/reminder-update`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${INT_TOKEN()}` },
          body: JSON.stringify({ id: r.id, action: 'snooze', minutes }),
        })
        if (res.ok) n++
      }
      return ctx.reply(`🔕 আজ রাত পর্যন্ত ${n}টি রিমাইন্ডার স্নুজ করা হয়েছে।`)
    }
    case 'catalog:status':
      return handleCatalogStatus(ctx)
    case 'sys:scheduler': {
      const data = await fetchInternal('/api/assistant/internal/watchdog')
      if (!data) return ctx.reply('❌ Scheduler স্ট্যাটাস লোড হয়নি')
      const lines = Object.entries(data.status ?? {}).map(([svc, s]) => {
        const icon = s.stale ? '🔴' : '🟢'
        return `${icon} ${svc}: ${s.lastBeatAt ?? 'কখনো নেই'}`
      }).join('\n')
      const sched = process.env.SCHEDULERS_ENABLED === 'true' ? 'চালু' : 'বন্ধ'
      return ctx.reply(`⚙️ *Scheduler*\nENV: ${sched}\n\n${lines || 'ডেটা নেই'}`, { parse_mode: 'Markdown' })
    }
    case 'sys:health': {
      const data = await fetchInternal('/api/assistant/internal/health')
      if (!data) return ctx.reply('❌ Health check ব্যর্থ')
      const icon = data.ok ? '🟢' : '🔴'
      return ctx.reply(
        `${icon} *Worker / App health*\nDB: ${data.db ? 'OK' : 'FAIL'}\nAgent: ${data.agentEnabled ? 'ON' : 'OFF'}\n${data.timestamp ?? ''}`,
        { parse_mode: 'Markdown' },
      )
    }
    default:
      return ctx.reply('অজানা মেনু বাটন')
  }
}
