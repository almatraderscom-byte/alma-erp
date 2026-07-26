/**
 * Mid-chat head changes — owner ruling 2026-07-26.
 *
 * *"ami cai professional agent app e ami same session model change korlew usage
 * accurate even model o nije bujhe ager context ba same jaga thekei shuru kore
 * amon e jeno hoy."*
 *
 * The conversation history is already passed to whichever head runs, so the new
 * model CAN see everything. What it does not know is that it is a new model:
 * without being told, a head reads the transcript as its own past work and can
 * re-introduce itself, restate the plan, or redo a step the previous head
 * already finished.
 *
 * So this is a short control note, added only on the FIRST turn after a switch.
 * It costs a few dozen tokens once, never on an unchanged conversation, and it
 * is deliberately about continuity rather than identity — Boss does not need the
 * agent announcing which engine it is running on.
 */
import { prisma } from '@/lib/prisma'
import { getModel, isKnownModelId } from '@/agent/lib/models/registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export interface ModelSwitch {
  previousModelId: string
  currentModelId: string
}

/** The head that produced the most recent assistant message in this chat. */
export async function previousHeadModelId(conversationId: string): Promise<string | null> {
  try {
    const rows = await db.agentMessage.findMany({
      where: { conversationId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { usage: true },
    })
    for (const row of rows) {
      const usage = row?.usage as Record<string, unknown> | null
      const id = typeof usage?.model === 'string' ? usage.model : null
      if (id && isKnownModelId(id)) return id
    }
    return null
  } catch {
    return null
  }
}

export function detectModelSwitch(previous: string | null, current: string): ModelSwitch | null {
  if (!previous || !current) return null
  if (previous === current) return null
  return { previousModelId: previous, currentModelId: current }
}

/**
 * The note itself, or '' when nothing changed. Kept short on purpose: a long
 * explanation would displace the work it is meant to protect.
 */
export function modelSwitchNote(change: ModelSwitch | null): string {
  if (!change) return ''
  const label = getModel(change.currentModelId)?.label ?? change.currentModelId
  return (
    `\n## এই টার্নে ইঞ্জিন বদলেছে\n`
    + `এই কথোপকথনের আগের উত্তরগুলো অন্য একটা মডেল লিখেছিল; এখন থেকে তুমি (${label}) চালাচ্ছ। `
    + `উপরের পুরো ইতিহাস তোমার কাছে আছে — সেটা পড়ে **ঠিক যেখানে কাজ থেমেছিল সেখান থেকেই** ধরো।\n`
    + `নতুন করে পরিচয় দিয়ো না, পরিকল্পনা আবার বোলো না, আর আগের টার্নে যা হয়ে গেছে সেটা আবার কোরো না। `
    + `Boss-কে ইঞ্জিন বদলের কথা বলার দরকার নেই — তিনি নিজেই বদলেছেন।\n`
  )
}

/** Convenience: everything in one call for the turn builder. */
export async function buildModelSwitchNote(
  conversationId: string,
  currentModelId: string,
): Promise<string> {
  const previous = await previousHeadModelId(conversationId)
  return modelSwitchNote(detectModelSwitch(previous, currentModelId))
}
