/**
 * WhatsApp tap-button approvals (owner) — the WhatsApp counterpart of the Telegram
 * inline approve/reject (and multi-step) buttons.
 *
 * AUDIT result: every owner approval — single OR multi-step — rides the SAME
 * `approve:<id>` / `reject:<id>` callback contract, where <id> is an AgentPendingAction.
 * Multi-step (e.g. snooze 1/2/4h, pick-staffer) just makes each option its own pending
 * action with its own `approve:<id>` button. So mirroring works by carrying the EXACT
 * callback string as each WhatsApp button's payload:
 *  - ≤3 options → interactive quick-reply buttons
 *  - 4–10 options → an interactive list picker
 * On tap, WhatsApp returns that payload (ButtonPayload / ListId); we parse
 * `approve:<id>` | `reject:<id>` and drive the EXISTING approve/reject route via Bearer
 * AGENT_INTERNAL_TOKEN — no new approval logic, no money-path change.
 *
 * Dormant until OWNER_WHATSAPP_NUMBER + Twilio creds (+ AGENT_INTERNAL_TOKEN for the
 * actual approve call) are set. Within the 24h window these are free service messages.
 */
import { prisma } from '@/lib/prisma'
import {
  sendTwilioWaContent,
  createTwilioQuickReplyContent,
  createTwilioListPickerContent,
  sendTwilioWaText,
  sendTwilioWaMedia,
  deleteTwilioContent,
  twilioWaConfigured,
} from './twilio-wa'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type OwnerCardButton = { title: string; payload: string } // payload = "approve:<id>" | "reject:<id>" | …

const last10 = (s: string) => String(s ?? '').replace(/\D/g, '').slice(-10)

function ownerWaConfigured(): boolean {
  return Boolean(process.env.OWNER_WHATSAPP_NUMBER) && twilioWaConfigured()
}

/** WhatsApp button titles cap at 20 chars; keep it readable. */
function clipTitle(s: string): string {
  const t = String(s ?? '').trim()
  return t.length <= 20 ? t : `${t.slice(0, 19)}…`
}

/**
 * Send the owner an interactive WhatsApp card (text + tap-buttons) whose buttons carry
 * the given callback payloads. ≤3 → quick-reply, 4–10 → list picker, >10 → first 10.
 * Best-effort + dormant. Returns a small result for diagnostics.
 */
export async function sendOwnerWaButtons(
  text: string,
  buttons: OwnerCardButton[],
): Promise<{ sent: boolean; reason?: string; sid?: string; error?: string }> {
  if (!ownerWaConfigured()) return { sent: false, reason: 'OWNER_WHATSAPP_NUMBER or Twilio not configured' }
  const to = process.env.OWNER_WHATSAPP_NUMBER as string
  const opts = buttons.filter((b) => b && b.payload && b.title).slice(0, 10)
  if (opts.length === 0) {
    const res = await sendTwilioWaText({ to, body: text })
    return { sent: !res.error, reason: 'no buttons → plain text', sid: res.sid, error: res.error }
  }
  try {
    // Buttons carry dynamic ids, so the Content is created per-card (proven to send
    // immediately within the 24h session window).
    const made =
      opts.length <= 3
        ? await createTwilioQuickReplyContent({
            friendlyName: `alma_wa_card_${Date.now()}`,
            buttons: opts.map((b) => ({ id: b.payload, title: clipTitle(b.title) })),
          })
        : await createTwilioListPickerContent({
            friendlyName: `alma_wa_list_${Date.now()}`,
            buttonText: 'বেছে নিন',
            items: opts.map((b) => ({ id: b.payload, item: clipTitle(b.title) })),
          })
    if (!made.sid) return { sent: false, reason: 'content_create_failed', error: made.error }
    const res = await sendTwilioWaContent({ to, contentSid: made.sid, contentVariables: { '1': text.slice(0, 1500) } })
    // One-shot template — clean it up so the Content library doesn't accumulate.
    void deleteTwilioContent(made.sid)
    return { sent: !res.error, sid: res.sid, error: res.error }
  } catch (err) {
    return { sent: false, reason: 'exception', error: err instanceof Error ? err.message : String(err) }
  }
}

/** Convenience: a standard ✅/❌ approve-reject card for one pending action. */
export async function sendOwnerWaApproval(summary: string, pendingActionId: string): Promise<void> {
  if (!ownerWaConfigured() || !pendingActionId) return
  await sendOwnerWaButtons(`📋 অনুমোদন প্রয়োজন:\n${summary}`, [
    { title: '✅ অনুমোদন', payload: `approve:${pendingActionId}` },
    { title: '❌ বাতিল', payload: `reject:${pendingActionId}` },
  ])
}

/**
 * Mirror a Telegram inline-keyboard card to WhatsApp. Accepts the same
 * `[{text, callback_data}]` rows the Telegram code already builds, so multi-step flows
 * can call this with one line. Only `approve:`/`reject:` payloads are actionable on
 * WhatsApp today (everything in the owner-approval system uses those).
 */
export async function mirrorOwnerKeyboardToWhatsApp(
  text: string,
  inlineKeyboard: Array<Array<{ text: string; callback_data: string }>>,
  photoUrl?: string,
): Promise<void> {
  if (!ownerWaConfigured()) return
  const flat = inlineKeyboard.flat().filter((b) => /^(approve|reject):/.test(b.callback_data ?? ''))
  if (flat.length === 0) return
  try {
    // Send the camera frame first (as its own media message) so the owner sees the same
    // photo Telegram shows, then the decision buttons.
    if (photoUrl && /^https?:\/\//i.test(photoUrl)) {
      const to = process.env.OWNER_WHATSAPP_NUMBER as string
      await sendTwilioWaMedia({ to, mediaUrl: photoUrl }).catch(() => undefined)
    }
    await sendOwnerWaButtons(text, flat.map((b) => ({ title: b.text, payload: b.callback_data })))
  } catch (err) {
    console.warn('[wa-approval] mirror failed:', err instanceof Error ? err.message : err)
  }
}

/**
 * Handle an inbound WhatsApp button/list tap. `payload` is the button id / list id we
 * set (e.g. "approve:<id>"). Returns true if it was an owner approve/reject we acted on.
 */
export async function handleOwnerApprovalButton(fromDigits: string, payload: string): Promise<boolean> {
  const m = /^(approve|reject):(.+)$/.exec(String(payload ?? '').trim())
  if (!m) return false
  const verb = m[1]
  const actionId = m[2]

  // Only the owner can drive approvals.
  const owner = process.env.OWNER_WHATSAPP_NUMBER
  if (!owner || last10(owner) !== last10(fromDigits)) return false

  // Safe no-op test payload from wa-selftest.
  if (actionId.startsWith('TEST-NO-OP')) {
    await sendOwnerWaNote(`✅ টেস্ট বাটন কাজ করছে (${verb}) — আসল কোনো অ্যাকশন বদলায়নি।`)
    return true
  }

  const base = (process.env.APP_URL ?? process.env.NEXTAUTH_URL ?? 'https://alma-erp-six.vercel.app').replace(/\/$/, '')
  const internal = process.env.AGENT_INTERNAL_TOKEN ?? ''
  try {
    const res = await fetch(`${base}/api/assistant/actions/${actionId}/${verb}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${internal}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'whatsapp' }),
      signal: AbortSignal.timeout(90_000),
    })
    if (res.ok) {
      await sendOwnerWaNote(verb === 'approve' ? '✅ অনুমোদিত হয়েছে।' : '❌ বাতিল করা হয়েছে।')
    } else {
      const data = (await res.json().catch(() => ({}))) as { error?: string; status?: string }
      const why = data.status === 'approved' || data.status === 'executed' ? 'এটা আগেই অনুমোদিত হয়ে গেছে।' : (data.error ?? String(res.status))
      await sendOwnerWaNote(`⚠️ ${why}`)
    }
  } catch (err) {
    await sendOwnerWaNote(`⚠️ অনুমোদন পাঠানো যায়নি: ${err instanceof Error ? err.message : String(err)}`)
  }
  return true
}

/** Diagnostic: send the owner a test card with REAL distinct payloads (safe no-op). */
export async function testWaApproval(kind: 'single' | 'multi' | 'photo' | 'list' = 'single'): Promise<{ sent: boolean; reason?: string; sid?: string; error?: string }> {
  if (!ownerWaConfigured()) return { sent: false, reason: 'OWNER_WHATSAPP_NUMBER or Twilio not configured' }
  if (kind === 'list') {
    // 5 options → forces the list-picker path (staff-picker style). Safe no-op.
    return sendOwnerWaButtons('📋 টেস্ট (৩+ অপশন, list) — একটা বেছে নিন, কিছু বদলাবে না:', [
      { title: 'করিম', payload: 'approve:TEST-NO-OP-a' },
      { title: 'রহিম', payload: 'approve:TEST-NO-OP-b' },
      { title: 'ইয়াফি', payload: 'approve:TEST-NO-OP-c' },
      { title: 'সাকিব', payload: 'approve:TEST-NO-OP-d' },
      { title: '❌ বাতিল', payload: 'reject:TEST-NO-OP-e' },
    ])
  }
  if (kind === 'photo') {
    // Exercises the photo-then-buttons path with a public sample image (safe no-op).
    await mirrorOwnerKeyboardToWhatsApp(
      '📋 টেস্ট (ছবিসহ) — ছবির নিচে বাটন আসবে, কিছু বদলাবে না:',
      [[
        { text: '✅ অনুমোদন', callback_data: 'approve:TEST-NO-OP' },
        { text: '❌ বাতিল', callback_data: 'reject:TEST-NO-OP' },
      ]],
      'https://demo.twilio.com/owl.png',
    )
    return { sent: true, reason: 'photo+buttons sent (check WhatsApp)' }
  }
  if (kind === 'multi') {
    return sendOwnerWaButtons('📋 টেস্ট (মাল্টি-স্টেপ) — একটা অপশন চাপুন, কিছু বদলাবে না:', [
      { title: '১ ঘণ্টা', payload: 'approve:TEST-NO-OP-1' },
      { title: '২ ঘণ্টা', payload: 'approve:TEST-NO-OP-2' },
      { title: '❌ বাতিল', payload: 'reject:TEST-NO-OP-3' },
    ])
  }
  return sendOwnerWaButtons('📋 টেস্ট অনুমোদন — ✅/❌ চাপুন (নিরাপদ, কিছু বদলাবে না):', [
    { title: '✅ অনুমোদন', payload: 'approve:TEST-NO-OP' },
    { title: '❌ বাতিল', payload: 'reject:TEST-NO-OP' },
  ])
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
