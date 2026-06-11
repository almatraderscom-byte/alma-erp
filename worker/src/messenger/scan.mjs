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

const PAGES = [
  { id: '1044848232034171', name: 'Alma Lifestyle',   envKey: 'FB_PAGE_TOKEN_LIFESTYLE' },
  { id: '827260860637393',  name: 'Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP' },
]

const ALERT_THRESHOLD_MS = 30 * 60 * 1000 // 30 min

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

export async function runMessengerScan({ supabase, bot }) {
  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID
  if (!ownerChatId) return

  let totalAlerts = 0

  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) {
      console.warn(`[messenger] ${page.envKey} not set — skipping ${page.name}`)
      continue
    }

    try {
      // Fetch recent conversations
      const convData = await fbGet(
        page.id,
        '/conversations?fields=id,updated_time,participants,messages{id,from,message,created_time,attachments}&limit=20',
        token,
      )

      for (const conv of convData.data ?? []) {
        const messages = conv.messages?.data ?? []
        const alerts   = detectAlerts(messages, page.id)

        for (const alert of alerts) {
          // Deduplicate: check if we already sent this alert today
          const today = new Date().toISOString().slice(0, 10)
          const { data: existing } = await supabase
            .from('messenger_alerts')
            .select('id')
            .eq('conversation_id', conv.id)
            .eq('alert_type', alert.type)
            .gte('detected_at', today + 'T00:00:00Z')
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
          })

          // Build owner notification
          const lastCustomerMsg = messages
            .filter(m => m.from?.id !== page.id)
            .sort((a, b) => new Date(b.created_time) - new Date(a.created_time))[0]

          const draft = draftReply(lastCustomerMsg?.message)

          const alertTypes: Record<string, string> = {
            unanswered_30min:    `📨 ${page.name}: ${alert.ageMin} মিনিট ধরে কাস্টমার উত্তর পাননি`,
            image_only_reply:    `🖼 ${page.name}: স্টাফ শুধু ছবি পাঠিয়েছে, টেক্সট/দাম নেই`,
            dead_after_question: `❓ ${page.name}: কাস্টমার প্রশ্ন করেছে, ${alert.ageMin} মিনিট উত্তর নেই`,
          }

          const alertMsg = alertTypes[alert.type] || `Alert: ${alert.type}`
          const tier = alert.urgency === 'critical' ? 2 : 1

          // Send to owner with inline buttons
          await bot.telegram.sendMessage(
            ownerChatId,
            `${alertMsg}\n\nকাস্টমার: "${lastCustomerMsg?.message?.slice(0, 80) ?? ''}"\n\n💬 _Draft:_ "${draft}"`,
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [[
                  { text: '📋 নতুন draft',      callback_data: `msg_draft:${conv.id}:${page.id}` },
                  { text: '👤 Staff-কে feedback', callback_data: `staff_feedback:${conv.id}:${page.id}` },
                ]],
              },
            },
          )

          totalAlerts++
          console.log(`[messenger] alert ${alert.type} for conv ${conv.id} on ${page.name}`)
        }
      }
    } catch (err) {
      console.error(`[messenger] scan error for ${page.name}:`, err.message)
    }
  }

  if (totalAlerts > 0) {
    console.log(`[messenger] scan complete — ${totalAlerts} new alerts sent`)
  }
}
