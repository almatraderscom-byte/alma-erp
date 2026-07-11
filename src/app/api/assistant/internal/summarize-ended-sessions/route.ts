/**
 * POST /api/assistant/internal/summarize-ended-sessions
 * One LLM call per idle ended chat → session_summary memory.
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/prisma'
import { agentSmartText } from '@/agent/lib/llm-text'
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

  const text = await agentSmartText({
    system:
      'You are the memory-keeper of a personal AI agent. Extract durable owner ' +
      'facts/preferences only. 2-8 Bangla bullets or exactly SKIP. NEVER miss a ' +
      'like/dislike — the owner audited the agent brain and found his ভালো লাগা / ' +
      'খারাপ লাগা were not being captured; that is the #1 failure to avoid.',
    prompt:
      'Summarize this owner↔agent chat for long-term memory. Extract ONLY durable items:\n' +
      '- ভালো লাগা / খারাপ লাগা: ANYTHING the owner liked, disliked, praised, or complained ' +
      'about (agent behavior, designs, products, people, routines) — capture these FIRST, ' +
      'verbatim-ish ("বসের ভালো লেগেছে: …" / "বসের পছন্দ না: …")\n' +
      '- Standing instructions / preferences ("এভাবে কর", "daily এটা করবি", "আর করবা না")\n' +
      '- Owner\'s key decisions and corrections (including corrections of the agent\'s mistakes ' +
      '— note the RIGHT behavior)\n' +
      '- Important business facts, numbers, people (নাম/সম্পর্ক/নম্বর), dates, habits\n' +
      '- Open action items / promises\n' +
      '- Things the owner said he STOPPED doing (mark with prefix "বাদ:") — the weekly memory ' +
      'revision uses these to flag stale memories\n' +
      'Do NOT include small talk, one-off queries, or transient data (live sales numbers etc.).\n' +
      'Output 2-8 short Bangla bullet points. If nothing durable, output exactly: SKIP\n\n' +
      transcript,
    maxTokens: 700,
    costLabel: 'session_summary',
  })
  return text.trim() || 'SKIP'
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
