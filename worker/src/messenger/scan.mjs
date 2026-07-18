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
import { resilientFetch } from '../fetch-retry.mjs'

// Phase 46: same env override as src/agent/lib/marketing/meta-version.ts
// (worker cannot import TS). Default = the contract-tested version.
const META_GRAPH_VERSION = () =>
  /^v\d{2}\.\d$/.test(process.env.META_GRAPH_VERSION ?? '') ? process.env.META_GRAPH_VERSION : 'v21.0'

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
  } catch (err) {
    console.warn('[messenger-scan] cs_mode fetch failed:', err.message)
    return 'off'
  }
}

async function isCsHandledConversation(fbConversationId) {
  if (!APP_URL() || !INT_TOKEN()) return false
  try {
    const res = await fetch(
      `${APP_URL()}/api/assistant/internal/cs-is-handled?conversationId=${encodeURIComponent(fbConversationId)}`,
      { headers: { Authorization: `Bearer ${INT_TOKEN()}` }, signal: AbortSignal.timeout(10_000) },
    )
    if (!res.ok) return false
    const data = await res.json()
    return Boolean(data.handled)
  } catch (err) {
    console.warn('[messenger-scan] cs-is-handled check failed:', err.message)
    return false
  }
}

async function fbGet(pageId, path, token, opts = {}) {
  const url = `https://graph.facebook.com/${META_GRAPH_VERSION()}/${pageId}${path}&access_token=${token}`
  // Graph queries here are heavy (conversations + nested messages); a hard 15s ceiling
  // with no retry was timing out and spamming the worker error log. Use resilientFetch
  // (30s + one retry on transient/abort).
  const res = await resilientFetch(url, { timeoutMs: opts.timeoutMs ?? 30_000, retries: opts.retries ?? 1 })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  if (!res.ok) {
    // Surface the real Facebook error (code / is_transient) so callers can tell a
    // Facebook-side blip (code 2, self-heals) from an actionable token/permission fault.
    const fbErr = json?.error ?? {}
    const e = new Error(`FB API ${res.status}: ${(fbErr.message ?? text ?? '').slice(0, 200)}`)
    e.httpStatus = res.status
    e.fbCode = fbErr.code
    e.fbSubcode = fbErr.error_subcode
    e.fbTransient = Boolean(fbErr.is_transient)
    throw e
  }
  return json
}

// One combined conversations+messages query is fast but fragile: a SINGLE unreadable
// thread on a page makes Facebook 500 the whole edge (observed 2026-07-18 on Alma Online
// Shop — feed worked, /conversations returned code 2 persistently). So: try the combined
// query first (cheap on healthy pages), and only if it fails fall back to a lightweight
// conversation list + per-thread message fetch, isolating the bad thread(s).
const CONV_MSG_FIELDS = 'messages{id,from,message,created_time,attachments}'

async function fetchConversations(page, token) {
  try {
    const data = await fbGet(
      page.id,
      `/conversations?fields=id,updated_time,participants,${CONV_MSG_FIELDS}&limit=20`,
      token,
    )
    return { conversations: data.data ?? [], degraded: false, skipped: 0 }
  } catch (combinedErr) {
    console.warn(
      `[messenger] combined conversations query failed for ${page.name} (${combinedErr.message}) — trying per-thread fallback`,
    )
    // If even the bare list fails, it is page/permission level, not one bad thread — rethrow.
    const list = await fbGet(page.id, '/conversations?fields=id,updated_time,participants&limit=20', token)
    const conversations = []
    let skipped = 0
    let consecutiveFail = 0
    for (const conv of list.data ?? []) {
      try {
        const full = await fbGet(conv.id, `?fields=${CONV_MSG_FIELDS}`, token, { timeoutMs: 12_000, retries: 0 })
        conversations.push({ ...conv, messages: full.messages })
        consecutiveFail = 0
      } catch (threadErr) {
        skipped++
        consecutiveFail++
        console.warn(`[messenger] skipping unreadable thread ${conv.id} on ${page.name}: ${threadErr.message}`)
        // Broad failure (not one bad thread) → surface as a page error instead of looping 20×.
        if (consecutiveFail >= 6) {
          const e = new Error(`per-thread fallback failing broadly: ${threadErr.message}`)
          e.httpStatus = threadErr.httpStatus
          e.fbCode = threadErr.fbCode
          e.fbTransient = threadErr.fbTransient
          throw e
        }
      }
    }
    return { conversations, degraded: true, skipped }
  }
}

// Turn a raw page-scan error into an owner-facing verdict: actionable faults (bad token,
// missing permission) get a precise fix; Facebook-side transient errors do not page the owner.
function classifyPageError(err, page) {
  const code = err.fbCode
  if (code === 190) {
    return { page: page.name, code, actionable: true, message: err.message,
      hint: 'page token অকার্যকর/মেয়াদোত্তীর্ণ — Business Manager-এ নতুন token নিন।' }
  }
  if (code === 200 || code === 10 || code === 3 || code === 100) {
    return { page: page.name, code, actionable: true, message: err.message,
      hint: 'inbox পড়ার permission নেই — Business Manager → App → pages_messaging access দিন।' }
  }
  // code 2 / HTTP 5xx / is_transient = Facebook-side, self-heals.
  return { page: page.name, code, actionable: false, message: err.message,
    hint: 'Facebook সাময়িক সমস্যা — নিজে ঠিক হবে, কিছু করতে হবে না।' }
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
      `https://graph.facebook.com/${META_GRAPH_VERSION()}/${page.id}?fields=name&access_token=${token}`,
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
  const scanErrors = []
  const degradedPages = []

  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) {
      console.warn(`[messenger] ${page.envKey} not set — skipping ${page.name}`)
      await notify({
        tier: 1,
        title: `⚠️ ${page.name} token নেই`,
        message: `${page.envKey} environment variable সেট করা হয়নি — messenger scan চলবে না।`,
        category: 'urgent',
      }).catch((err) => {
        console.warn(`[messenger-scan] token-missing notify failed for ${page.name}:`, err.message)
      })
      continue
    }

    const tokenOk = await checkPageTokenHealth(page, token)
    if (!tokenOk) continue

    try {
      // Fetch recent conversations (resilient: recovers good threads if one thread is unreadable)
      const { conversations, degraded, skipped } = await fetchConversations(page, token)
      if (degraded && skipped > 0) {
        degradedPages.push({ name: page.name, pageId: page.id, skipped })
      }

      for (const conv of conversations) {
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
      scanErrors.push(classifyPageError(err, page))
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

  // Degraded pages (recovered via per-thread fallback) — tell the owner ONCE per Dhaka day,
  // not every 15 min, and make clear his token is fine and no action is needed.
  for (const dp of degradedPages) {
    const today = dhakaToday()
    const dayStart = dhakaDayStartUtc(today)
    const dedupId = `scan_degraded_${dp.pageId}`
    const { data: already } = await supabase
      .from('messenger_alerts')
      .select('id')
      .eq('conversation_id', dedupId)
      .eq('alert_type', 'scan_degraded')
      .gte('detected_at', dayStart)
      .limit(1)
    if (already?.length) continue
    await supabase.from('messenger_alerts').insert({
      id:              crypto.randomUUID(),
      page_id:         dp.pageId,
      conversation_id: dedupId,
      alert_type:      'scan_degraded',
      detected_at:     new Date().toISOString(),
      detected_date:   today,
    }).catch((e) => console.warn('[messenger] degraded dedup insert failed:', e.message))
    if (bot && ownerChatId) {
      await bot.telegram.sendMessage(
        ownerChatId,
        `ℹ️ ${dp.name}: Facebook ${dp.skipped}টি thread পড়তে পারছে না, বাকি inbox ঠিকঠাক scan হয়েছে। আপনার token ঠিক আছে — কিছু করতে হবে না।`,
      ).catch((e) => console.warn('[messenger] degraded notify failed:', e.message))
    }
  }

  if (scanErrors.length > 0) {
    console.error(`[messenger] scan errors: ${scanErrors.map(e => `${e.page}: ${e.message}`).join('; ')}`)
    // Only page the owner for ACTIONABLE faults (bad token / missing permission) with the exact
    // fix. Facebook-side transient errors (code 2, self-heal) are logged only — no 15-min spam,
    // no useless "log দেখুন" (the log lived on the VPS where the owner could not see it).
    const actionable = scanErrors.filter(e => e.actionable)
    if (actionable.length > 0 && bot && ownerChatId) {
      await bot.telegram.sendMessage(
        ownerChatId,
        `⚠️ Messenger scan সমস্যা:\n${actionable.map(e => `• ${e.page}: ${e.hint}`).join('\n')}`,
      ).catch((e) => console.warn('[messenger] error notification failed:', e.message))
    } else {
      console.warn('[messenger] only Facebook-side transient errors this scan — owner not paged')
    }
  }

  console.log(`[messenger] scan complete — ${pagesScanned}/${PAGES.length} pages scanned, ${totalAlerts} new alerts, ${scanErrors.length} errors, ${degradedPages.length} degraded (cs_mode=${csMode})`)
  return {
    dutyStatus: scanErrors.length === PAGES.length ? 'failed' : pagesScanned > 0 ? 'done' : 'skipped',
    dutyDetail: `${pagesScanned} page scanned, ${totalAlerts} alerts${scanErrors.length ? `, ${scanErrors.length} error` : ''}`,
  }
}
