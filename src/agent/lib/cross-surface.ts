/**
 * Recent conversation snippets from OTHER surfaces (web vs Telegram).
 */
import { prisma } from '@/lib/prisma'

export type CrossSurfaceSnippet = {
  conversationId: string
  title: string
  lastAssistantLine: string
  updatedAt: string
}

/**
 * True only when the owner explicitly points at a different/prior chat. This is
 * intentionally narrower than generic words such as "before" or "previous":
 * standalone image generation should not inherit stale conversations, while an
 * explicit "use the campaign from the other chat" request must retain recall.
 */
export function referencesOtherConversation(text: string): boolean {
  return /(?:\b(?:other|another|different|separate|previous|prior|earlier|last)\s+(?:chat|conversation|thread)\b|\b(?:chat|conversation|thread)\s+(?:from|we\s+had\s+in)\s+(?:before|earlier)\b|(?:অন্য|আলাদা|আগের|পূর্বের)\s*(?:চ্যাট|কথোপকথন|কনভারসেশন|থ্রেড)|(?:onno|alada|ager|agerer|purber)\s*(?:chat|conversation|thread))/i.test(text)
}

function extractAssistantText(content: unknown): string {
  if (!content) return ''
  if (typeof content === 'string') return content.slice(0, 200)
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: string }).text ?? ''
      if (text.trim()) return text.replace(/\s+/g, ' ').trim().slice(0, 200)
    }
  }
  return ''
}

export async function loadRecentOtherConversations(
  currentConversationId: string,
  limit = 5,
): Promise<CrossSurfaceSnippet[]> {
  try {
    const convos = await prisma.agentConversation.findMany({
      where: {
        id: { not: currentConversationId },
        archived: false,
      },
      orderBy: { updatedAt: 'desc' },
      take: limit + 2,
      select: {
        id: true,
        title: true,
        updatedAt: true,
        messages: {
          where: { role: 'assistant' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { content: true },
        },
      },
    })

    return convos
      .filter((c) => c.id !== currentConversationId)
      .slice(0, limit)
      .map((c) => ({
        conversationId: c.id,
        title: c.title ?? '(শিরোনাম নেই)',
        lastAssistantLine: extractAssistantText(c.messages[0]?.content) || '(কোনো উত্তর নেই)',
        updatedAt: c.updatedAt.toISOString(),
      }))
  } catch {
    return []
  }
}
