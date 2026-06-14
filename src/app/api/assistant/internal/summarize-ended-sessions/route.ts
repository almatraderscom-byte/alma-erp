/**
 * POST /api/assistant/internal/summarize-ended-sessions
 * One LLM call per idle ended chat → session_summary memory.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL } from '@/agent/config'
import { createOrUpdateAgentMemory } from '@/agent/lib/agent-memory'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

export const runtime = 'nodejs'
export const maxDuration = 120

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

function extractMessageText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .filter((b): b is { type: string; text?: string } => typeof b === 'object' && b !== null && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim()
}

async function summarizeConversation(messages: Array<{ role: string; content: unknown }>): Promise<string> {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? 'Owner' : 'Agent'}: ${extractMessageText(m.content)}`)
    .filter((line) => line.length > 8)
    .join('\n')
    .slice(0, 12000)

  if (!transcript.trim()) return 'SKIP'

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const res = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 500,
    messages: [{
      role: 'user',
      content:
        'Summarize this owner↔agent business chat. Extract ONLY:\n' +
        '- Owner\'s key decisions / instructions\n' +
        '- Preferences expressed\n' +
        '- Important business facts mentioned\n' +
        '- Open action items\n' +
        'Output 2-5 short Bangla bullet points. If nothing durable, output exactly: SKIP\n\n' +
        transcript,
    }],
  })

  const block = res.content.find((b) => b.type === 'text')
  return block && block.type === 'text' ? block.text.trim() : 'SKIP'
}

export async function POST(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { idleMinutes?: number; maxSessions?: number }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const idleMinutes = Math.min(Math.max(Number(body.idleMinutes ?? 30), 5), 24 * 60)
  const maxSessions = Math.min(Math.max(Number(body.maxSessions ?? 5), 1), 10)
  const cutoff = new Date(Date.now() - idleMinutes * 60_000)
  const today = todayYmdDhaka()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const candidates = await db.agentConversation.findMany({
    where: {
      archived: false,
      source: { in: ['web', 'telegram'] },
      summarizedAt: null,
      OR: [
        { lastMessageAt: { lt: cutoff } },
        { lastMessageAt: null, updatedAt: { lt: cutoff } },
      ],
    },
    orderBy: { lastMessageAt: 'asc' },
    take: maxSessions * 3,
    select: { id: true, title: true, source: true },
  })

  let summarized = 0
  const processed: string[] = []

  for (const conv of candidates) {
    if (summarized >= maxSessions) break

    const count = await db.agentMessage.count({ where: { conversationId: conv.id } })
    if (count < 4) {
      await db.agentConversation.update({
        where: { id: conv.id },
        data: { summarizedAt: new Date() },
      })
      continue
    }

    const messages = await db.agentMessage.findMany({
      where: { conversationId: conv.id },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
      take: 80,
    })

    try {
      const summary = await summarizeConversation(messages)
      if (summary && summary !== 'SKIP' && !/^skip$/i.test(summary)) {
        await createOrUpdateAgentMemory({
          scope: 'business',
          key: `session_${conv.id.slice(0, 8)}`,
          content: summary,
          pinned: false,
          metadata: {
            type: 'session_summary',
            conversationId: conv.id,
            date: today,
            source: conv.source,
          },
        })
      }
      await db.agentConversation.update({
        where: { id: conv.id },
        data: { summarizedAt: new Date() },
      })
      summarized++
      processed.push(conv.id)
    } catch (err) {
      console.warn('[summarize-ended-sessions] failed for', conv.id, err)
    }
  }

  return NextResponse.json({ summarized, processed, idleMinutes })
}
