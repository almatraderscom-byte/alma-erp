/**
 * WhatsApp tap-button approvals (owner) — the WhatsApp counterpart of the Telegram
 * approve/reject inline buttons.
 *
 * Flow:
 *  1. When an approval card is sent (sendOwnerApprovalCard), we ALSO send the owner a
 *     WhatsApp quick-reply message (✅ অনুমোদন / ❌ বাতিল) and remember which
 *     AgentPendingAction it maps to (KV `wa_pending_approval`).
 *  2. When the owner taps a button, WhatsApp delivers an inbound with ButtonPayload
 *     ("approve"/"reject"); the Twilio webhook calls handleOwnerApprovalButton(), which
 *     looks up the remembered action id and drives the EXISTING approve/reject route
 *     (Bearer AGENT_INTERNAL_TOKEN) — no new approval logic, no money path changes.
 *
 * Safe: a tap only ever resolves the single most-recent pending action we sent, the
 * route itself re-checks status==='pending', and everything is DORMANT until
 * OWNER_WHATSAPP_NUMBER + Twilio creds + AGENT_INTERNAL_TOKEN are set.
 */
import { prisma } from '@/lib/prisma'
import { sendTwilioWaContent, createTwilioQuickReplyContent, sendTwilioWaText, twilioWaConfigured } from './twilio-wa'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const CONTENT_SID_KEY = 'wa_approval_content_sid'
const PENDING_KEY = 'wa_pending_approval'
const PENDING_TTL_MS = 60 * 60 * 1000 // 1h — approvals are short-lived

async function kvGet(key: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key }, select: { value: true } })
    return row?.value ?? null
  } catch {
    return null
  }
}
async function kvSet(key: string, value: string): Promise<void> {
  try {
    await db.agentKvSetting.upsert({ where: { key }, create: { key, value }, update: { value } })
  } catch {
    /* best-effort */
  }
}

const last10 = (s: string) => String(s ?? '').replace(/\D/g, '').slice(-10)

function ownerWaConfigured(): boolean {
  return Boolean(process.env.OWNER_WHATSAPP_NUMBER) && twilioWaConfigured()
}

/** Lazily create + cache the quick-reply Content template; returns its ContentSid. */
async function ensureApprovalContentSid(): Promise<string | null> {
  const cached = await kvGet(CONTENT_SID_KEY)
  if (cached) return cached
  const res = await createTwilioQuickReplyContent({
    friendlyName: 'alma_wa_approval',
    buttons: [
      { id: 'approve', title: '✅ অনুমোদন' },
      { id: 'reject', title: '❌ বাতিল' },
    ],
  })
  if (res.sid) {
    await kvSet(CONTENT_SID_KEY, res.sid)
    return res.sid
  }
  console.warn('[wa-approval] content create failed:', res.error)
  return null
}

/**
 * Send the owner a WhatsApp tap-button approval mirroring a Telegram approval card.
 * Best-effort + dormant; remembers which pending action this maps to.
 */
export async function sendOwnerWaApproval(summary: string, pendingActionId: string): Promise<void> {
  if (!ownerWaConfigured() || !pendingActionId) return
  const to = process.env.OWNER_WHATSAPP_NUMBER as string
  try {
    const contentSid = await ensureApprovalContentSid()
    if (!contentSid) {
      // Fallback: at least tell the owner on WhatsApp (no buttons available).
      await sendTwilioWaText({ to, body: `📋 অনুমোদন প্রয়োজন:\n${summary}\n\n(Telegram-এ বাটন দিয়ে অনুমোদন করুন)` })
      return
    }
    await kvSet(PENDING_KEY, JSON.stringify({ actionId: pendingActionId, at: new Date().toISOString() }))
    await sendTwilioWaContent({
      to,
      contentSid,
      contentVariables: { '1': `📋 অনুমোদন প্রয়োজন:\n${summary}`.slice(0, 1500) },
    })
  } catch (err) {
    console.warn('[wa-approval] send failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Handle an inbound WhatsApp button tap. Returns true if it WAS an owner approval button
 * we acted on (so the webhook can skip normal ingest for it).
 */
export async function handleOwnerApprovalButton(fromDigits: string, buttonPayload: string): Promise<boolean> {
  const payload = String(buttonPayload ?? '').trim().toLowerCase()
  if (payload !== 'approve' && payload !== 'reject') return false

  // Only the owner can drive approvals.
  const owner = process.env.OWNER_WHATSAPP_NUMBER
  if (!owner || last10(owner) !== last10(fromDigits)) return false

  const raw = await kvGet(PENDING_KEY)
  if (!raw) return false
  let actionId = ''
  let at = 0
  try {
    const p = JSON.parse(raw) as { actionId?: string; at?: string }
    actionId = p.actionId ?? ''
    at = p.at ? new Date(p.at).getTime() : 0
  } catch {
    return false
  }
  if (!actionId) return false
  if (at && Date.now() - at > PENDING_TTL_MS) {
    await kvSet(PENDING_KEY, '')
    await sendOwnerWaNote('⌛ অনুমোদনের সময় শেষ হয়ে গেছে — অ্যাকশনটি আর নেই।')
    return true
  }

  const base = (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
  const internal = process.env.AGENT_INTERNAL_TOKEN ?? ''
  const route = payload === 'approve' ? 'approve' : 'reject'
  try {
    const res = await fetch(`${base}/api/assistant/actions/${actionId}/${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${internal}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'whatsapp' }),
      signal: AbortSignal.timeout(60_000),
    })
    await kvSet(PENDING_KEY, '') // consume it either way
    if (res.ok) {
      await sendOwnerWaNote(payload === 'approve' ? '✅ অনুমোদিত হয়েছে।' : '❌ বাতিল করা হয়েছে।')
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string }
      await sendOwnerWaNote(`⚠️ করা গেল না: ${data.error ?? res.status}${data.status ? ` (${data.status})` : ''}`)
    }
  } catch (err) {
    await sendOwnerWaNote(`⚠️ অনুমোদন পাঠানো যায়নি: ${err instanceof Error ? err.message : String(err)}`)
  }
  return true
}

/** Diagnostic: create/cache the content template and send the owner a test approval. */
export async function testWaApproval(): Promise<{ contentSid?: string | null; sent?: unknown; reason?: string }> {
  if (!ownerWaConfigured()) return { reason: 'OWNER_WHATSAPP_NUMBER or Twilio not configured' }
  const contentSid = await ensureApprovalContentSid()
  if (!contentSid) return { contentSid: null, reason: 'content template create failed (see logs)' }
  const to = process.env.OWNER_WHATSAPP_NUMBER as string
  await kvSet(PENDING_KEY, JSON.stringify({ actionId: 'TEST-NO-OP', at: new Date().toISOString() }))
  const sent = await sendTwilioWaContent({
    to,
    contentSid,
    contentVariables: { '1': '📋 টেস্ট অনুমোদন — বাটন কাজ করছে কিনা দেখতে নিচের ✅/❌ চাপুন।' },
  })
  return { contentSid, sent }
}

/** Small confirmation back to the owner on WhatsApp (best-effort). */
async function sendOwnerWaNote(text: string): Promise<void> {
  const to = process.env.OWNER_WHATSAPP_NUMBER
  if (!to) return
  try {
    await sendTwilioWaText({ to, body: text })
  } catch {
    /* best-effort */
  }
}
