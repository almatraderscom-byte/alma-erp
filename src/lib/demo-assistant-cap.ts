/**
 * Daily ceiling on assistant turns for the demo instance.
 *
 * Running the real assistant over the demo's fake data is the most convincing part
 * of the demo — but a visitor can send as many messages as they like, and every one
 * of them spends the owner's model budget. The per-minute limiter does not help:
 * it is in-memory (so it resets with every lambda) and it only smooths bursts, not
 * a full day of someone playing with the chat.
 *
 * The quota is **reserved atomically**, not counted. Counting rows and then deciding
 * lets a burst of concurrent requests all read the same under-limit number and all
 * proceed — serverless gives no shared process to serialize them. A single
 * conditional UPSERT does the increment and the limit test in one statement, so the
 * ceiling holds no matter how many instances are running.
 *
 * A reservation is spent even if the model call later fails. That is deliberate: the
 * alternative is refunding on error, which is exactly the path an abusive loop would
 * take.
 *
 * Production never sets DEMO_MODE, so this is inert there.
 */
import { prisma } from '@/lib/prisma'
import { isDemoDeployment } from '@/lib/demo-mode'

const DEFAULT_DAILY_LIMIT = 50
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000

export type DemoAssistantCap = { blocked: boolean; limit: number }

/** Current Asia/Dhaka calendar date, e.g. `2026-08-17`. */
function dhakaDateKey(): string {
  return new Date(Date.now() + DHAKA_OFFSET_MS).toISOString().slice(0, 10)
}

export async function reserveDemoAssistantTurn(): Promise<DemoAssistantCap> {
  if (!isDemoDeployment()) return { blocked: false, limit: 0 }

  const raw = Number(process.env.DEMO_ASSISTANT_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT)
  const limit = Number.isFinite(raw) ? Math.floor(raw) : DEFAULT_DAILY_LIMIT
  // A limit of 0 or below is a deliberate "off" switch, not a misconfiguration to
  // fall back from — treat it as blocking rather than silently spending money.
  if (limit <= 0) return { blocked: true, limit: 0 }

  const key = `demo:assistant:turns:${dhakaDateKey()}`

  try {
    // One statement: insert the day's first reservation, or increment only while the
    // stored count is still below the limit. No rows back means the day is spent.
    const rows = await prisma.$queryRaw<Array<{ value: string }>>`
      INSERT INTO agent_kv_settings (key, value, updated_at)
      VALUES (${key}, '1', now())
      ON CONFLICT (key) DO UPDATE
        SET value = (agent_kv_settings.value::int + 1)::text, updated_at = now()
        WHERE agent_kv_settings.value::int < ${limit}
      RETURNING value
    `
    return { blocked: rows.length === 0, limit }
  } catch {
    // If the reservation cannot be made, fail closed: an unmetered demo assistant is
    // the one outcome this module exists to prevent.
    return { blocked: true, limit }
  }
}
