/**
 * Artifact tools — deliver finished documents as FILES in the chat, the way the
 * Claude app does (owner request 2026-07-11: "report link keno? direct file
 * pathaw — ami click korle report dekhbo, then share korbo").
 *
 * save_artifact files a document as an AgentArtifact row; the chat UI shows a
 * clickable file card in the reply flow and auto-opens the artifacts panel
 * (rendered markdown, copy + download buttons). The SEO audit tool files its
 * reports automatically; the head uses this for every OTHER report/document it
 * authors (research, marketing plan, comparison, proposal…).
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/**
 * Shared helper: create (or refresh) a conversation artifact and return the
 * card payload core.ts turns into a chat file card. Same-title artifacts in the
 * same conversation UPDATE in place (version bump) instead of duplicating.
 */
export async function saveConversationArtifact(input: {
  conversationId: string | null
  title: string
  content: string
  type?: string
}): Promise<{ id: string; title: string; type: string; version: number }> {
  // AgentArtifact rows hang off a conversation (schema: conversationId required).
  if (!input.conversationId) throw new Error('artifact needs a conversation context')
  const type = (input.type ?? 'markdown').toLowerCase()
  const title = input.title.trim().slice(0, 140)
  const existing = await db.agentArtifact.findFirst({
    where: { conversationId: input.conversationId, title },
    orderBy: { createdAt: 'desc' },
    select: { id: true, version: true },
  })
  if (existing) {
    const row = await db.agentArtifact.update({
      where: { id: existing.id },
      data: { content: input.content, type, version: (existing.version ?? 1) + 1 },
      select: { id: true, title: true, type: true, version: true },
    })
    return { id: row.id, title: row.title ?? title, type: row.type ?? type, version: row.version }
  }
  const row = await db.agentArtifact.create({
    data: { conversationId: input.conversationId, type, title, content: input.content, version: 1 },
    select: { id: true, title: true, type: true, version: true },
  })
  return { id: row.id, title: row.title ?? title, type: row.type ?? type, version: row.version }
}

const save_artifact: AgentTool = {
  name: 'save_artifact',
  description:
    'Deliver a finished document to the owner as a FILE in the chat (like the Claude app): the reply ' +
    'gets a clickable file card and the document opens in the artifacts panel with rendered ' +
    'markdown + copy/download buttons — the owner can then share/download it himself.\n' +
    'USE whenever your deliverable is a DOCUMENT: any report the owner will keep or hand a client ' +
    '(research, marketing plan, competitor analysis, proposal, before/after, meeting notes). Pass the ' +
    'FULL document as `content` (Bangla markdown, complete — not a summary), a short `title` (this is ' +
    'the file name the owner sees), and optional `type` ("markdown" default; "html"/"svg" render live).\n' +
    'The SEO audit tool files its report automatically — do not double-save that one. After saving, ' +
    'still write a short summary of the document in your reply; the file replaces pasted walls of ' +
    'text and raw links, not the conversation. Saving again with the SAME title updates the file ' +
    '(new version) instead of creating a duplicate.',
  input_schema: {
    type: 'object' as const,
    properties: {
      title: { type: 'string', description: 'Short Bangla file title the owner sees on the card, e.g. "Competitor বিশ্লেষণ — brandx.com".' },
      content: { type: 'string', description: 'The COMPLETE document body (markdown unless type says otherwise).' },
      type: { type: 'string', enum: ['markdown', 'html', 'svg', 'code'], description: 'Document kind (default markdown).' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['title', 'content'],
  },
  handler: async (input) => {
    try {
      const title = String(input.title ?? '').trim()
      const content = String(input.content ?? '')
      if (!title || content.trim().length < 40) {
        return { success: false, error: 'title এবং পূর্ণাঙ্গ content দুটোই লাগবে (content খুব ছোট)।' }
      }
      const artifact = await saveConversationArtifact({
        conversationId: typeof input.conversationId === 'string' ? input.conversationId : null,
        title,
        content,
        type: typeof input.type === 'string' ? input.type : 'markdown',
      })
      return {
        success: true,
        data: {
          artifactCard: artifact,
          note: 'ফাইলটা চ্যাটে file card হিসেবে চলে গেছে — reply-তে ছোট সারাংশ দাও, পুরো ডকুমেন্ট আবার পেস্ট কোরো না।',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ARTIFACT_TOOLS: AgentTool[] = [save_artifact]
