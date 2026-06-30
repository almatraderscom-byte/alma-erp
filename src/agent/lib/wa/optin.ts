/**
 * Staff WhatsApp daily opt-in (owner feature, step 2).
 *
 * Staff must message the business WhatsApp once each morning to open WhatsApp's
 * 24h window (so the agent can send them task/reminder/announcement messages free,
 * no template). Their inbound message is matched to their ERP User by phone and
 * recorded for the day. The home page can then GATE on it (lock until opted in).
 *
 * Safety: everything fails OPEN — any error returns "not gated / already opted in"
 * so a glitch can NEVER lock staff out. The gate itself is OFF until the owner sets
 * the `wa_staff_optin_gate` KV to "on" (no redeploy).
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Today's date in Asia/Dhaka (YYYY-MM-DD). */
function dhakaDate(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

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
    /* best-effort — never throw into a webhook */
  }
}

/** Owner kill switch for the staff opt-in GATE (home-page lock). Default OFF. */
export async function waStaffGateEnabled(): Promise<boolean> {
  const v = (await kvGet('wa_staff_optin_gate'))?.trim().toLowerCase()
  return v === 'on' || v === 'true' || v === '1'
}

/** Record that a user opted in today (sent the business a WhatsApp message). */
export async function recordWaOptIn(userId: string): Promise<void> {
  if (!userId) return
  await kvSet(`wa_optin:${userId}:${dhakaDate()}`, '1')
}

/** Has this user opted in (messaged the business on WhatsApp) today? */
export async function hasOptedInToday(userId: string): Promise<boolean> {
  if (!userId) return false
  return (await kvGet(`wa_optin:${userId}:${dhakaDate()}`)) === '1'
}

/**
 * Match an inbound WhatsApp sender number to an ERP User id by phone. Compares the
 * last 10 digits so +880 / 0 / country-code variations still match. Returns null
 * (fail-safe) on any miss or error.
 */
export async function findUserIdByPhone(fromNumber: string): Promise<string | null> {
  const d = String(fromNumber ?? '').replace(/\D/g, '')
  if (d.length < 7) return null
  const last10 = d.slice(-10)
  try {
    const users: Array<{ id: string; phone: string | null }> = await db.user.findMany({
      where: { phone: { not: null } },
      select: { id: true, phone: true },
      take: 1000,
    })
    for (const u of users) {
      const p = String(u.phone ?? '').replace(/\D/g, '')
      if (p && p.slice(-10) === last10) return u.id
    }
  } catch {
    /* fail-safe → no match */
  }
  return null
}
