/**
 * Staff WhatsApp notifications (worker) — a best-effort SECOND channel alongside Telegram
 * for staff task dispatch / announcements.
 *
 * SAFETY: completely DORMANT + kill-switched. Sends nothing unless
 *   STAFF_WHATSAPP_ENABLED === 'true'  AND  Twilio WhatsApp creds (TWILIO_WHATSAPP_FROM)
 * are set. Never throws into the caller, so it can NEVER disrupt the existing Telegram
 * delivery. Free-form WhatsApp only reaches a staffer inside the 24h window after THEY
 * last messaged the business number (the staff opt-in flow), so it naturally no-ops for
 * staff who haven't opted in — Telegram stays the reliable channel.
 */
import { createClient } from '@supabase/supabase-js'

function staffWaEnabled() {
  return process.env.STAFF_WHATSAPP_ENABLED === 'true'
}
function waConfigured() {
  return Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_FROM,
  )
}
export function staffWhatsAppActive() {
  return staffWaEnabled() && waConfigured()
}

function toWa(phone) {
  const raw = String(phone ?? '').trim()
  if (raw.toLowerCase().startsWith('whatsapp:')) return raw
  const cleaned = raw.replace(/[^\d+]/g, '')
  return `whatsapp:${cleaned.startsWith('+') ? cleaned : `+${cleaned}`}`
}

async function staffPhone(supabase, staffId) {
  try {
    const { data: s } = await supabase.from('agent_staff').select('user_id').eq('id', staffId).maybeSingle()
    if (!s?.user_id) return null
    const { data: u } = await supabase.from('User').select('phone').eq('id', s.user_id).maybeSingle()
    return u?.phone ?? null
  } catch {
    return null
  }
}

/**
 * Best-effort WhatsApp copy of a staff message. Never throws.
 * @param {object} p
 * @param {import('@supabase/supabase-js').SupabaseClient} [p.supabase]
 * @param {string} p.staffId
 * @param {string} p.text
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function sendStaffWhatsApp({ supabase, staffId, text }) {
  if (!staffWhatsAppActive()) return { sent: false, reason: 'disabled' }
  if (!staffId || !String(text ?? '').trim()) return { sent: false, reason: 'missing args' }
  try {
    const sb =
      supabase ?? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
    const phone = await staffPhone(sb, staffId)
    if (!phone) return { sent: false, reason: 'no phone on file' }
    const sid = process.env.TWILIO_ACCOUNT_SID
    const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        From: toWa(process.env.TWILIO_WHATSAPP_FROM),
        To: toWa(phone),
        Body: String(text).slice(0, 1600),
      }).toString(),
    })
    if (!res.ok) {
      const d = await res.json().catch(() => ({}))
      return { sent: false, reason: d.message ?? `Twilio HTTP ${res.status}` }
    }
    return { sent: true }
  } catch (err) {
    return { sent: false, reason: err?.message ?? String(err) }
  }
}
