/**
 * "Owner abroad" call switch — when ON, the agent must not ring the owner's BD
 * number (salah calls, urgent tier-3 calls, proactive/owner two-way calls). Set
 * from the salah-times settings card; read by the web call path here and by the
 * VPS worker via agent_kv_settings (worker/src/owner-call-lock.mjs).
 *
 * This blocks only OWNER-destined calls. Staff/contact calls are unaffected —
 * unlike owner_call_lock_until, which time-boxes everything.
 */
import { prisma } from '@/lib/prisma'

export const OWNER_ABROAD_KEY = 'owner_abroad_calls_off'

export async function isOwnerAbroadCallsOff(): Promise<boolean> {
  try {
    const row = await prisma.agentKvSetting.findUnique({
      where: { key: OWNER_ABROAD_KEY },
      select: { value: true },
    })
    return row?.value === 'true'
  } catch {
    // If the read fails, behave like the toggle is off — a missed reminder call
    // is recoverable; silently never calling the owner again is not.
    return false
  }
}

export async function setOwnerAbroadCallsOff(off: boolean): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key: OWNER_ABROAD_KEY },
    create: { key: OWNER_ABROAD_KEY, value: off ? 'true' : 'false' },
    update: { value: off ? 'true' : 'false' },
  })
}
