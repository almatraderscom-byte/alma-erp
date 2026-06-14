import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runCustomerIntel({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) {
    console.warn('[customer-intel] TELEGRAM_OWNER_CHAT_ID not set — skipped')
    return
  }

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/customer-segments`, {
      headers: { Authorization: `Bearer ${INT()}` },
    })
    if (!res.ok) {
      console.warn('[customer-intel] API failed:', res.status)
      return
    }
    const seg = await res.json()

    const L = ['🤝 *সাপ্তাহিক কাস্টমার রিপোর্ট*', '']

    if (seg.winBack?.length) {
      L.push(`🔄 *Win-back* (${seg.winBack.length}): ৪৫+ দিন কেনেনি এমন রিপিট কাস্টমার`)
      seg.winBack.slice(0, 8).forEach((c) => {
        L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'} — ${c.ordersCount}টি অর্ডার, ${c.daysSinceLastOrder} দিন আগে`)
      })
      L.push('💡 এদের জন্য একটা অফার পোস্ট boost করুন বা মেসেজ করুন।')
      L.push('')
    }

    if (seg.atRisk?.length) {
      L.push(`⚠️ *At-risk* (${seg.atRisk.length}): ৩০–৪৫ দিন নেই`)
      seg.atRisk.slice(0, 5).forEach((c) => {
        L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'} — ${c.ordersCount}টি অর্ডার, ${c.daysSinceLastOrder} দিন`)
      })
      L.push('')
    }

    if (seg.loyal?.length) {
      L.push(`⭐ *Loyal* (top ${Math.min(seg.loyal.length, 5)}):`)
      seg.loyal.slice(0, 5).forEach((c) => {
        L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'} — ${c.ordersCount}টি অর্ডার`)
      })
      L.push('💡 এদের special care/থ্যাংকস দিন — repeat রাখুন।')
      L.push('')
    }

    if (seg.newRecent?.length) {
      L.push(`🆕 *নতুন* (${seg.newRecent.length}): গত ১৪ দিনে প্রথম অর্ডার`)
      seg.newRecent.slice(0, 3).forEach((c) => {
        L.push(`• ${c.name ?? c.phone ?? 'কাস্টমার'}`)
      })
    }

    if (L.length <= 2) L.push('এই সপ্তাহে উল্লেখযোগ্য segment নেই।')

    await sendMarkdownSafe(bot.telegram, ownerChatId, L.join('\n'))
  } catch (e) {
    console.error('[customer-intel] failed:', e.message)
  }
}
