/**
 * Per-turn MODEL IDENTITY — kills the "I am Claude Sonnet" hallucination.
 *
 * The head system prompt never tells the running model WHICH model it is, so when
 * the owner asks "which model are you?", whatever model actually runs (DeepSeek /
 * Grok / Gemini / Qwen / Claude) has no grounding and guesses — and these models
 * routinely default to claiming "Claude Sonnet" (confidently, and wrong). This
 * module builds a short per-turn note, injected into the VOLATILE turn context
 * (not the cached system prefix, so it never busts prompt caching), that pins the
 * real identity and — when the owner switched models mid-conversation — says so
 * truthfully so the head can answer "yes Boss, you changed the model".
 */
import { prisma } from '@/lib/prisma'
import { getModel, isKnownModelId } from '@/agent/lib/models/registry'

/**
 * The model that produced the PREVIOUS assistant turn in this conversation, read
 * from the persisted `usage.model` tag (run-owner-turn.ts / core.ts both write it
 * on every assistant message). null on the first turn or when unreadable. Lets the
 * head detect — and truthfully report — a mid-conversation model switch.
 */
export async function loadPreviousTurnModelId(conversationId: string): Promise<string | null> {
  try {
    const row = await prisma.agentMessage.findFirst({
      where: { conversationId, role: 'assistant' },
      orderBy: { createdAt: 'desc' },
      select: { usage: true },
    })
    const m = (row?.usage as { model?: unknown } | null)?.model
    return typeof m === 'string' && m.trim() ? m.trim() : null
  } catch {
    // Identity note is best-effort — a lookup glitch must never block the turn.
    return null
  }
}

/**
 * Per-turn note pinning the head's REAL identity (currentModelId) and, when the
 * owner switched models since the last assistant turn, telling it so. Bangla,
 * owner-facing voice.
 */
export function buildModelIdentityNote(currentModelId: string, prevModelId?: string | null): string {
  const cur = getModel(currentModelId)
  const lines: string[] = [
    `## তোমার আসল পরিচয় (এই টার্নে নিশ্চিত — অনুমান নয়)`,
    `তুমি এখন **${cur.label}** (\`${cur.apiModel}\`) মডেলে চলছো। কেউ "তুমি কোন model", ` +
      `"তুমি কি Claude/Sonnet/GPT" — এমন জিজ্ঞেস করলে ঠিক **${cur.label}** বলবে। অনুমান করে ` +
      `অন্য কোনো মডেলের নাম (Claude/Sonnet/GPT/অন্য কিছু) কখনো দাবি করবে না — নিশ্চিত না হলেও ` +
      `এই লাইনটাই একমাত্র সত্য।`,
  ]
  if (prevModelId && isKnownModelId(prevModelId) && prevModelId !== currentModelId) {
    const prev = getModel(prevModelId)
    lines.push(
      `এই কথোপকথনে আগের উত্তরটা চলেছিল **${prev.label}** দিয়ে; Boss এখন মডেল পাল্টে ` +
        `**${cur.label}** করেছেন। Boss জিজ্ঞেস করলে সততার সাথে বলবে: ` +
        `"হ্যাঁ Boss, ${prev.label} থেকে ${cur.label}-এ পাল্টেছেন।"`,
    )
  }
  return lines.join('\n')
}
