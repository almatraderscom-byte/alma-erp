/**
 * Daily ceiling on assistant turns for the demo instance.
 *
 * Running the real assistant over the demo's fake data is the most convincing part
 * of the demo — but a visitor can send as many messages as they like, and every one
 * of them spends the owner's model budget. The per-minute limiter does not help:
 * it is in-memory (so it resets with every lambda) and it only smooths bursts, not
 * a full day of someone playing with the chat.
 *
 * The count comes from AgentTurn rows since Dhaka midnight, so it holds across
 * lambdas and across every visitor sharing the demo.
 *
 * Production never sets DEMO_MODE, so this is inert there.
 */
import { prisma } from '@/lib/prisma'
import { isDemoDeployment } from '@/lib/demo-mode'

const DEFAULT_DAILY_LIMIT = 50
const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000

export type DemoAssistantCap = { blocked: boolean; used: number; limit: number }

/** Start of the current Asia/Dhaka day, as a UTC instant. */
function dhakaDayStart(): Date {
  const nowDhaka = new Date(Date.now() + DHAKA_OFFSET_MS)
  const midnight = Date.UTC(nowDhaka.getUTCFullYear(), nowDhaka.getUTCMonth(), nowDhaka.getUTCDate())
  return new Date(midnight - DHAKA_OFFSET_MS)
}

export async function checkDemoAssistantCap(): Promise<DemoAssistantCap> {
  if (!isDemoDeployment()) return { blocked: false, used: 0, limit: 0 }

  const raw = Number(process.env.DEMO_ASSISTANT_DAILY_LIMIT ?? DEFAULT_DAILY_LIMIT)
  const limit = Number.isFinite(raw) ? raw : DEFAULT_DAILY_LIMIT
  // A limit of 0 or below is a deliberate "off" switch, not a misconfiguration to
  // fall back from — treat it as blocking rather than silently spending money.
  if (limit <= 0) return { blocked: true, used: 0, limit: 0 }

  try {
    const used = await prisma.agentTurn.count({ where: { startedAt: { gte: dhakaDayStart() } } })
    return { blocked: used >= limit, used, limit }
  } catch {
    // If the count cannot be read, fail closed: an unmetered demo assistant is the
    // one outcome this module exists to prevent.
    return { blocked: true, used: 0, limit }
  }
}
