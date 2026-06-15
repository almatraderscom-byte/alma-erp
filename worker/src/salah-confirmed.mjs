/**
 * Hard stop for salah Twilio — block calls/retries once owner confirmed a waqt.
 * Worker mirror of src/agent/lib/salah-resolve.ts isOwnerConfirmed.
 */

const SETTLED_STATUSES = new Set(['prayed_on_time', 'prayed_late', 'qaza'])

export function isOwnerConfirmedRecord(rec) {
  if (!rec) return false
  const status = rec.status
  const confirmedAt = rec.confirmedAt ?? rec.confirmed_at ?? null
  return SETTLED_STATUSES.has(status) || Boolean(confirmedAt)
}

function appConfig() {
  return {
    appUrl: (process.env.APP_URL ?? '').replace(/\/$/, ''),
    token: process.env.AGENT_INTERNAL_TOKEN ?? '',
  }
}

/** Fetch today's (or given date) record for waqt — returns true if owner confirmed. */
export async function isSalahWaqtConfirmed(dateYmd, waqt) {
  if (!dateYmd || !waqt) return false

  const { appUrl, token } = appConfig()
  if (!appUrl || !token) return false

  try {
    const res = await fetch(`${appUrl}/api/assistant/internal/salah-record?date=${encodeURIComponent(dateYmd)}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return false
    const body = await res.json()
    const rec = body.records?.find((r) => r.waqt === waqt)
    return isOwnerConfirmedRecord(rec)
  } catch (err) {
    console.warn('[salah-confirmed] fetch failed:', err.message)
    return false
  }
}

/** Abort salah Twilio if owner already confirmed this waqt. */
export async function isSalahCallBlocked(dateYmd, waqt) {
  if (!dateYmd || !waqt) return { blocked: false }
  const confirmed = await isSalahWaqtConfirmed(dateYmd, waqt)
  if (confirmed) {
    return { blocked: true, reason: 'owner_confirmed', dateYmd, waqt }
  }
  return { blocked: false }
}
