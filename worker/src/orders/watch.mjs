import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runOrderWatch({ bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId || !bot) return

  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/order-issues`, {
      headers: { Authorization: `Bearer ${INT()}` },
      cache: 'no-store',
    })
    if (!res.ok) {
      console.warn('[order-watch] API', res.status)
      return
    }

    const body = await res.json()
    const issues = body?.issues
    if (!issues?.length) return

    const L = ['📦 *অর্ডার সতর্কতা*', '']
    for (const issue of issues) {
      const mark = issue.severity === 'high' ? '🔴' : '🟡'
      L.push(`${mark} ${issue.detail}`)
      if (issue.orders?.length) {
        L.push(`   _${issue.orders.slice(0, 5).join(', ')}_`)
      }
    }
    L.push('')
    L.push('বিস্তারিত দেখতে agent-কে জিজ্ঞেস করুন বা ERP order section দেখুন।')

    await sendMarkdownSafe(bot.telegram, ownerChatId, L.join('\n'))
    console.log(`[order-watch] alerted owner — ${issues.length} issue(s)`)
  } catch (e) {
    console.error('[order-watch] failed:', e.message)
  }
}
