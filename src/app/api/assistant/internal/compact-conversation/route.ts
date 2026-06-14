/**
 * POST /api/assistant/internal/compact-conversation
 * Summarizes a conversation and creates a new one seeded with the summary.
 * Auth: internal token (worker) OR session (web owner).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { getToken } from 'next-auth/jwt'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { isSystemOwner } from '@/lib/roles'
import { AGENT_MODEL } from '@/agent/config'
import { requireAgentEnabled } from '@/agent/lib/guards'

export const runtime = 'nodejs'
export const maxDuration = 60

function checkInternalToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!token) return false
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch { return false }
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()
}

async function summarizeForCompaction(messages: Array<{ role: string; content: unknown }>): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Owner' : 'Agent'}: ${extractText(m.content)}`)
    .filter((line) => line.length > 8)
    .join('\n')
    .slice(0, 16000)

  if (!transcript.trim()) return ''

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const res = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 400,
    system:
      'You are summarizing a conversation for continuity. Extract:\n' +
      '- The user\'s main goal/topic\n' +
      '- Key decisions made\n' +
      '- Important facts/numbers mentioned\n' +
      '- Any open action items or pending questions\n' +
      'Output a tight Bangla summary (5-8 bullets). This will be used as context for a fresh conversation so the agent can keep helping seamlessly.',
    messages: [{
      role: 'user',
      content: 'Summarize this owner↔agent conversation for seamless continuation:\n\n' + transcript,
    }],
  })

  const block = res.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text.trim() : ''
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const isInternal = checkInternalToken(req)
  if (!isInternal) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub || !isSystemOwner(token)) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  let body: { conversationId?: string }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'invalid_json' }, { status: 400 }) }

  const conversationId = body.conversationId
  if (!conversationId) return NextResponse.json({ error: 'conversationId required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const conv = await db.agentConversation.findUnique({
    where: { id: conversationId },
    select: { id: true, projectId: true, source: true, model: true, compactedToId: true },
  })
  if (!conv) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (conv.compactedToId) {
    return NextResponse.json({ error: 'already_compacted', newConversationId: conv.compactedToId }, { status: 409 })
  }

  const messages = await db.agentMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: 'asc' },
    select: { role: true, content: true },
    take: 100,
  })

  const summary = await summarizeForCompaction(messages)
  if (!summary) {
    return NextResponse.json({ error: 'summary_empty' }, { status: 422 })
  }

  const newConv = await db.agentConversation.create({
    data: {
      title: conv.title ? `${conv.title} (cont.)` : null,
      model: conv.model,
      source: conv.source,
      projectId: conv.projectId,
      contextSummary: summary,
    },
    select: { id: true },
  })

  await db.agentConversation.update({
    where: { id: conversationId },
    data: { compactedToId: newConv.id, archived: true },
  })

  return NextResponse.json({ newConversationId: newConv.id, summary })
}
