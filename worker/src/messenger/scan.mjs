/**
 * Messenger Scan — runs every 15 minutes
 * Scans both Alma pages for:
 *   1. Unanswered customer messages >30 min
 *   2. Image-only staff replies (no text/price)
 *   3. Dead conversation after a customer question
 *
 * Tracks the Meta 24h window for urgency.
 * Agent NEVER messages customers — alerts go to owner only.
 */

import { notify } from '../notify/index.mjs'
import { recordReplyStats } from './reply-stats.mjs'
import { buildCallbackData } from '../telegram/callback-data.mjs'
import { sendMarkdownSafe } from '../telegram/markdown-safe.mjs'

const PAGES = [
  { id: '1044848232034171', name: 'Alma Lifestyle',   envKey: 'FB_PAGE_TOKEN_LIFESTYLE' },
  { id: '827260860637393',  name: 'Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP' },
]

const ALERT_THRESHOLD_MS = 30 * 60 * 1000 // 30 min
const MAX_INDIVIDUAL_CARDS = 8
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

function dhakaToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

function dhakaDayStartUtc(dhakaDate) {
  return new Date(`${dhakaDate}T00:00:00+06:00`).toISOString()
}

async function getCsMode() {
  if (!APP_URL() || !INT_TOKEN()) return 'off'
  try {
    const res = await fetch(`${APP_URL()}/api/assistant/internal/agent-settings?keys=cs_mode`, {
      headers: { Authorization: `Bearer ${INT_TOKEN()}` },
    })
    if (!res.ok) return 'off'
    const data = await res.json()
    return data.cs_mode ?? 'off'
  } catch {
    return 'off'
  }
}

async function isCsHandledConversation(fbConversationId) {
  if (!APP_URL() || !INT_TOKEN()) return false
  try {
    const res = await fetch(
      `${APP_URL()}/api/assistant/internal/cs-is-handled?conversationId=${encodeURIComponent(fbConversationId)}`,
      { headers: { Authorization: `Bearer ${INT_TOKEN()}` } },
    )
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.handled)
  } catch {
    return false
  }
}

async function fbGet(pageId, path, token) {
  const url = `https://graph.facebook.com/v21.0/${pageId}${path}&access_token=${token}`
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`FB API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

/**
 * Detects alert conditions in a conversation thread.
 */
function detectAlerts(messages, pageId) {
  if (!messages?.length) return []

  const alerts = []
  const now = Date.now()

  // Sort by created_time ascending
  const sorted = [...messages].sort((a, b) =>
    new Date(a.created_time) - new Date(b.created_time)
  )

  const lastMsg  = sorted[sorted.length - 1]
  const isFromCustomer = lastMsg?.from?.id !== pageId

  // Alert 1: unanswered customer message >30 min
  if (isFromCustomer) {
    const ageMs = now - new Date(lastMsg.created_time).getTime()
    if (ageMs > ALERT_THRESHOLD_MS) {
      const meta24hWindowMs = 24 * 60 * 60 * 1000
      const isUrgent = ageMs > (meta24hWindowMs - 2 * 60 * 60 * 1000) // <2h left in 24h window

      alerts.push({
        type:     'unanswered_30min',
        urgency:  isUrgent ? 'critical' : 'normal',
        ageMin:   Math.round(ageMs / 60000),
        lastMsg:  lastMsg.message?.slice(0, 100) ?? '(no text)',
        senderId: lastMsg.from?.id,
      })
    }
  }

  // Alert 2: image-only staff reply (no text/price)
  for (let i = sorted.length - 1; i >= 0; i--) {
    const msg = sorted[i]
    if (msg.from?.id === pageId) {
      // Staff message
      const hasText = msg.message && msg.message.trim().length > 0
      const hasAttachment = msg.attachments?.data?.length > 0
      if (hasAttachment && !hasText) {
        alerts.push({ type: 'image_only_reply', msgId: msg.id })
      }
      break
    }
  }

  // Alert 3: dead after customer question
  if (isFromCustomer) {
    const ageMs = now - new Date(lastMsg.created_time).getTime()
    const isQuestion = lastMsg.message?.includes('?') ||
      /কি|কেন|কোথায়|কত|কিভাবে|কবে|দাম|price|cost/i.test(lastMsg.message ?? '')
    if (ageMs > ALERT_THRESHOLD_MS && isQuestion) {
      alerts.push({
        type:    'dead_after_question',
        question: lastMsg.message?.slice(0, 100) ?? '',
        ageMin:  Math.round(ageMs / 60000),
      })
    }
  }

  return alerts
}

/**
 * Generate a Bangla draft reply suggestion based on the conversation context.
 */
function draftReply(lastCustomerMsg) {
  const msg = lastCustomerMsg?.toLowerCase() ?? ''
  if (/দাম|price|cost|কত/.test(msg)) {
    return 'আমাদের পণ্যের মূল্য জানতে inbox করুন অথবা আমাদের পেজ ভিজিট করুন। ধন্যবাদ।'
  }
  if (/available|stock|আছে/.test(msg)) {
    return 'হ্যাঁ, পণ্যটি এখন available। অর্ডার করতে আপনার নাম, ঠিকানা ও ফোন নম্বর দিন।'
  }
  return 'আস্সালামু আলাইকুম! আপনার মেসেজ পেয়েছি। আমরা শীঘ্রই যোগাযোগ করব। জাযাকাল্লাহ খাইর।'
}

async function checkPageTokenHealth(page, token) {
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${page.id}?fields=name&access_token=${token}`,
    )
    if (!res.ok) {
      const err = await res.text()
      await notify({
        tier: 1,
        title: `⚠️ ${page.name} token অকার্যকর`,
        message: `${page.name}-র page token কাজ করছে না — Meta App-এ গিয়ে নতুন করুন। Error: ${err.slice(0, 100)}`,
        category: 'urgent',
      })
      return false
    }
    return true
  } catch (err) {
    console.error(`[messenger] token health check failed for ${page.name}:`, err.message)
    return false
  }
}

export async function runMessengerScan({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  const csMode = await getCsMode()
  // When CS is OFF: do not generate drafts or flood per-message cards.
  // Still run reply-stats tracking + a SINGLE digest of how many are waiting.
  const draftsEnabled = csMode !== 'off'
  let offDigestCount = 0
  const offDigestSamples = []
  let overflowCount = 0
  const overflowSamples = []
  let individualSent = 0

  let totalAlerts = 0
  let pagesScanned = 0

  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) {
      console.warn(`[messenger] ${page.envKey} not set — skipping ${page.name}`)
      await notify({
        tier: 1,
        title: `⚠️ ${page.name} token নেই`,
        message: `${page.envKey} environment variable সেট করা হয়নি — messenger scan চলবে না।`,
        category: 'urgent',
      }).catch(() => {})
      continue
    }

    const tokenOk = await checkPageTokenHealth(page, token)
    if (!tokenOk) continue

    try {
      // Fetch recent conversations
      const convData = await fbGet(
        page.id,
        '/conversations?fields=id,updated_time,participants,messages{id,from,message,created_time,attachments}&limit=20',
        token,
      )

      for (const conv of convData.data ?? []) {
        const messages = conv.messages?.data ?? []

        // Reply-time tracking (no message content stored)
        try {
          await recordReplyStats({
            supabase,
            pageId: page.id,
            conversationId: conv.id,
            messages,
          })
        } catch (err) {
          console.warn(`[messenger] reply-stats error conv ${conv.id}:`, err.message)
        }

        const alerts   = detectAlerts(messages, page.id)

        // CS agent already replied — skip false "late reply" owner alerts
        if (await isCsHandledConversation(conv.id)) {
          continue
        }

        for (const alert of alerts) {
          // Deduplicate: check if we already sent this alert today (Dhaka business day)
          const today = dhakaToday()
          const dayStart = dhakaDayStartUtc(today)
          const { data: existing } = await supabase
            .from('messenger_alerts')
            .select('id')
            .eq('conversation_id', conv.id)
            .eq('alert_type', alert.type)
            .gte('detected_at', dayStart)
            .eq('resolved', false)
            .limit(1)

          if (existing?.length > 0) continue // already alerted today

          // Log the alert
          await supabase.from('messenger_alerts').insert({
            id:              crypto.randomUUID(),
            page_id:         page.id,
            conversation_id: conv.id,
            alert_type:      alert.type,
            detected_at:     new Date().toISOString(),
            detected_date:   today,
          })

          // Build owner notification
          const lastCustomerMsg = messages
            .filter(m => m.from?.id !== page.id)
            .sort((a, b) => new Date(b.created_time) - new Date(a.created_time))[0]

          const preview = (lastCustomerMsg?.message ?? '').slice(0, 40)

          if (!draftsEnabled) {
            offDigestCount++
            if (offDigestSamples.length < 5) {
              offDigestSamples.push(`• ${page.name}: "${preview}"`)
            }
            totalAlerts++
            continue
          }

          if (individualSent >= MAX_INDIVIDUAL_CARDS) {
            overflowCount++
            if (overflowSamples.length < 5) {
              overflowSamples.push(`• ${page.name}: "${preview}"`)
            }
            totalAlerts++
            continue
          }

          const draft = draftReply(lastCustomerMsg?.message)

          const alertTypes = {
            unanswered_30min:    `📨 ${page.name}: ${alert.ageMin} মিনিট ধরে কাস্টমার উত্তর পাননি`,
            image_only_reply:    `🖼 ${page.name}: স্টাফ শুধু ছবি পাঠিয়েছে, টেক্সট/দাম নেই`,
            dead_after_question: `❓ ${page.name}: কাস্টমার প্রশ্ন করেছে, ${alert.ageMin} মিনিট উত্তর নেই`,
          }

          const alertMsg = alertTypes[alert.type] || `Alert: ${alert.type}`

          // Send to owner with inline buttons
          const draftCb = buildCallbackData('msg_draft', conv.id)
          const feedbackCb = buildCallbackData('staff_feedback', conv.id)
          await sendMarkdownSafe(
            bot.telegram,
            ownerChatId,
            `${alertMsg}\n\nকাস্টমার: "${lastCustomerMsg?.message?.slice(0, 80) ?? ''}"\n\n💬 Draft: "${draft}"`,
            {
              reply_markup: {
                inline_keyboard: [[
                  { text: '📋 নতুন draft', callback_data: draftCb },
                  { text: '👤 Staff-কে feedback', callback_data: feedbackCb },
                ]],
              },
            },
          )

          individualSent++
          totalAlerts++
          console.log(`[messenger] alert ${alert.type} for conv ${conv.id} on ${page.name}`)
        }
      }
      pagesScanned++
    } catch (err) {
      console.error(`[messenger] scan error for ${page.name}:`, err.message)
    }
  }

  if (!draftsEnabled && offDigestCount > 0) {
    await sendMarkdownSafe(
      bot.telegram,
      ownerChatId,
      `🔕 CS mode *off* — ${offDigestCount}টি unreplied কাস্টমার মেসেজ আছে (draft পাঠানো হয়নি)।\n\n` +
        offDigestSamples.join('\n') +
        `\n\nReply চালু করতে: /csshadow বা /csauto`,
      { parse_mode: 'Markdown' },
    )
  } else if (overflowCount > 0) {
    await sendMarkdownSafe(
      bot.telegram,
      ownerChatId,
      `📨 এই scan-এ আরও ${overflowCount}টি unreplied মেসেজ আছে (${MAX_INDIVIDUAL_CARDS}টির বেশি card পাঠানো হয়নি)।\n\n` +
        overflowSamples.join('\n'),
      { parse_mode: 'Markdown' },
    )
  }

  console.log(`[messenger] scan complete — ${pagesScanned}/${PAGES.length} pages scanned, ${totalAlerts} new alerts (cs_mode=${csMode})`)
}
