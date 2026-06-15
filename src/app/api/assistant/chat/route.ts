import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled, requireAnthropicApiKey } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { runAgentTurn } from '@/agent/lib/core'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'
import { ASSISTANT_CHAT_RATE_LIMIT_PER_MIN } from '@/agent/lib/constants'
import { checkAssistantChatRateLimit } from '@/lib/assistant-rate-limit'
import { captureAgentError } from '@/agent/lib/sentry'
import { ensurePersonalProject, isPersonalProject } from '@/lib/personal-space'
import { isPersonalSnoozeMessage, setPersonalSnoozeToday } from '@/lib/personal-snooze'
import { PERSONAL_MODE_SENTINEL } from '@/agent/lib/personal-prompt'
import { compactConversationIfNeeded, COMPACT_THRESHOLD_USD } from '@/agent/lib/conversation-compact'
import {
  inheritConversationBusinessId,
  isAgentBusinessId,
  type AgentBusinessId,
} from '@/lib/agent-api/business-context'

export const runtime = 'nodejs'
export const maxDuration = 300

interface FileRef { bucket: string; path: string; mediaType: string }

interface ChatBody {
  conversationId?: string
  message?: string
  files?: FileRef[]
  projectId?: string
  personalMode?: boolean
  source?: string
}

function isAgentDbError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /agent_(conversations|messages|projects)/i.test(msg)
    || /relation .* does not exist/i.test(msg)
    || /P2021|P2010/.test(msg)
}

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const keyMissing = requireAnthropicApiKey()
  if (keyMissing) return keyMissing

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const isInternalCall = verifyInternalToken(bearerToken)

  if (!isInternalCall) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: ChatBody
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return Response.json({ error: 'message_required' }, { status: 400 })

  if (isPersonalSnoozeMessage(message)) {
    try {
      await setPersonalSnoozeToday()
    } catch (err) {
      console.warn('[assistant/chat] personal snooze set failed:', err)
    }
  }

  const rateKey = isInternalCall
    ? `internal:${bearerToken.slice(0, 8)}`
    : `session:${typeof body.conversationId === 'string' ? body.conversationId : req.headers.get('x-forwarded-for') ?? 'anon'}`
  const rate = checkAssistantChatRateLimit(rateKey, ASSISTANT_CHAT_RATE_LIMIT_PER_MIN)
  if (!rate.ok) {
    return Response.json(
      { error: 'rate_limited', message: 'অনেক দ্রুত মেসেজ পাঠানো হচ্ছে। এক মিনিট পরে আবার চেষ্টা করুন।', retryAfterSec: rate.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(rate.retryAfterSec) } },
    )
  }

  const files: FileRef[] = Array.isArray(body.files)
    ? body.files.filter((f) => f && typeof f.path === 'string' && typeof f.mediaType === 'string')
    : []

  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  let projectSystemInstructions: string | null = null
  let personalMode = body.personalMode === true
  let requestedProjectId = typeof body.projectId === 'string' ? body.projectId : null
  // Business scope for the turn — resolved from project or conversation row.
  let businessId: AgentBusinessId | null = null

  if (requestedProjectId && !personalMode) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const proj = await (prisma as any).agentProject.findUnique({
      where: { id: requestedProjectId },
      select: { name: true, systemInstructions: true, businessId: true },
    })
    if (isPersonalProject(proj)) personalMode = true
    if (!personalMode && isAgentBusinessId(proj?.businessId)) {
      businessId = proj.businessId as AgentBusinessId
    }
  }

  if (personalMode && !requestedProjectId) {
    requestedProjectId = await ensurePersonalProject()
  }

  try {
    if (conversationId) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const conv = await (prisma as any).agentConversation.findUnique({
        where: { id: conversationId },
        select: {
          id: true,
          projectId: true,
          businessId: true,
          project: { select: { name: true, systemInstructions: true, businessId: true } },
        },
      })
      if (!conv) return Response.json({ error: 'conversation_not_found' }, { status: 404 })
      personalMode = isPersonalProject(conv.project) || personalMode
      projectSystemInstructions = personalMode
        ? null
        : (conv.project?.systemInstructions ?? null)
      if (!personalMode) {
        if (isAgentBusinessId(conv.businessId)) {
          businessId = conv.businessId as AgentBusinessId
        } else if (isAgentBusinessId(conv.project?.businessId)) {
          businessId = conv.project!.businessId as AgentBusinessId
          // Backfill on the conversation for future turns.
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (prisma as any).agentConversation.update({
              where: { id: conversationId },
              data: { businessId },
            })
          } catch { /* non-critical */ }
        }
      }
      if (personalMode && conv.projectId !== requestedProjectId && requestedProjectId) {
        await prisma.agentConversation.update({
          where: { id: conversationId },
          data: { projectId: requestedProjectId },
        })
      }
    } else {
      const source = isInternalCall ? 'telegram' : 'web'
      const today = todayYmdDhaka()
      const title = personalMode
        ? `Telegram ব্যক্তিগত ${today}`
        : isInternalCall
          ? `Telegram ${today}`
          : (message.slice(0, 60) || null)

      if (isInternalCall) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existing = await (prisma as any).agentConversation.findFirst({
          where: { title, source: 'telegram' },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            projectId: true,
            businessId: true,
            project: { select: { name: true, systemInstructions: true, businessId: true } },
          },
        })
        if (existing) {
          conversationId = existing.id
          personalMode = isPersonalProject(existing.project) || personalMode
          projectSystemInstructions = personalMode ? null : (existing.project?.systemInstructions ?? null)
          if (!personalMode) {
            if (isAgentBusinessId(existing.businessId)) {
              businessId = existing.businessId as AgentBusinessId
            } else if (isAgentBusinessId(existing.project?.businessId)) {
              businessId = existing.project!.businessId as AgentBusinessId
            }
          }
        }
      }

      if (!conversationId) {
        const inherited = personalMode
          ? null
          : await inheritConversationBusinessId(requestedProjectId)
        if (inherited) businessId = inherited
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conv: { id: string } = await (prisma as any).agentConversation.create({
          data: {
            title,
            model: 'claude-sonnet-4-6',
            source,
            projectId: personalMode ? requestedProjectId : (requestedProjectId ?? null),
            businessId: personalMode ? null : businessId,
          },
          select: { id: true },
        })
        conversationId = conv.id
        if (personalMode) projectSystemInstructions = null
      }
    }

    if (personalMode) {
      projectSystemInstructions = null
    } else if (projectSystemInstructions === PERSONAL_MODE_SENTINEL) {
      projectSystemInstructions = null
    }

    type StoredBlock = { type: string; [k: string]: unknown }
    const userContent: StoredBlock[] = [
      ...files.map((f) => ({ type: 'file_ref', bucket: f.bucket, path: f.path, mediaType: f.mediaType })),
      ...(files.length > 0
        ? [{
            type: 'text',
            text: files
              .map((f) => `[Uploaded file path for tools: ${f.path}]`)
              .join('\n'),
          }]
        : []),
      { type: 'text', text: message },
    ]

    await prisma.agentMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: userContent as unknown as Parameters<typeof prisma.agentMessage.create>[0]['data']['content'],
      },
    })
    await touchConversationActivity(conversationId)
  } catch (err) {
    console.error('[assistant/chat] persistence failed', err)
    if (isAgentDbError(err)) {
      return Response.json({
        error: 'agent_db_not_migrated',
        message: 'Agent database tables are missing. Run prisma migrate deploy on production.',
      }, { status: 503 })
    }
    return Response.json({
      error: 'server_error',
      message: err instanceof Error ? err.message : String(err),
    }, { status: 500 })
  }

  const streamMode = req.nextUrl.searchParams.get('stream') !== 'false'
  const telegramFastPath =
    isInternalCall
    && (body.source === 'telegram' || req.headers.get('x-agent-source') === 'telegram')
  if (!streamMode) {
    const turnStarted = Date.now()
    let finalText = ''
    let errorMsg = ''
    const pendingCards: Array<{
      pendingActionId: string
      summary: string
      actionType?: string
      entryCount?: number
      isFinance?: boolean
      isBatch?: boolean
    }> = []
    const askCards: Array<{ askCardId: string; question: string; options: string[] }> = []
    let newConversationId: string | null = null
    let compactedFromCost: number | null = null
    try {
      for await (const event of runAgentTurn(conversationId!, {
        projectSystemInstructions,
        personalMode,
        telegramFastPath,
        businessId,
      })) {
        if (event.type === 'text_delta') finalText += event.delta
        else if (event.type === 'verification_retry') {
          // Drop the unverified draft so the final telegram reply is the truthful retry only.
          finalText = ''
          console.warn(
            `[assistant/chat] verification retry ${event.attempt}/${event.maxAttempts}`,
            { conversationId, categories: event.categories },
          )
        }
        else if (event.type === 'confirm_card') {
          pendingCards.push({
            pendingActionId: event.pendingActionId,
            summary: event.summary,
            actionType: event.actionType,
            entryCount: event.entryCount,
            isFinance: event.isFinance,
            isBatch: event.isBatch,
          })
        }
        else if (event.type === 'ask_card') askCards.push({ askCardId: event.askCardId, question: event.question, options: event.options })
        else if (event.type === 'error') { errorMsg = event.message; break }
        else if (event.type === 'done') {
          const turnCost = (event as { costUsd?: number }).costUsd ?? 0
          if (turnCost > 0 && conversationId) {
            try {
              await prisma.agentConversation.update({
                where: { id: conversationId },
                data: { totalCostUsd: { increment: turnCost } },
              })
            } catch { /* non-critical */ }
          }
          break
        }
      }
      if (!errorMsg && conversationId && !isInternalCall) {
        try {
          const compacted = await compactConversationIfNeeded(conversationId, COMPACT_THRESHOLD_USD)
          if (compacted) {
            newConversationId = compacted.newConversationId
            compactedFromCost = compacted.costUsd
            conversationId = compacted.newConversationId
          }
        } catch (err) {
          console.warn('[assistant/chat] auto-compact failed:', err)
        }
      }
    } catch (err) {
      errorMsg = err instanceof Error ? err.message : String(err)
    }
    if (errorMsg) return Response.json({ error: errorMsg }, { status: 500 })
    const turnMs = Date.now() - turnStarted
    if (telegramFastPath && turnMs > 30_000) {
      console.warn(`[assistant/chat] slow telegram turn ${turnMs}ms conv=${conversationId}`)
    }
    return Response.json({
      conversationId,
      text: finalText,
      pendingCards,
      askCards,
      personalMode,
      newConversationId,
      compactedFromCost,
      compactSuggested: Boolean(newConversationId),
    })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      const enqueue = (evt: unknown) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`))

      enqueue({ type: 'conversation_id', id: conversationId })
      enqueue({ type: 'personal_mode', active: personalMode })
      try {
        for await (const event of runAgentTurn(conversationId!, {
          projectSystemInstructions,
          personalMode,
          signal: req.signal,
          telegramFastPath,
          businessId,
        })) {
          enqueue(event)
          if (event.type === 'done') {
            const turnCost = (event as { costUsd?: number }).costUsd ?? 0
            if (turnCost > 0 && conversationId) {
              try {
                await prisma.agentConversation.update({
                  where: { id: conversationId },
                  data: { totalCostUsd: { increment: turnCost } },
                })
              } catch { /* non-critical */ }
            }
            break
          }
          if (event.type === 'error') break
        }

        if (conversationId) {
          try {
            const compacted = await compactConversationIfNeeded(conversationId, COMPACT_THRESHOLD_USD)
            if (compacted) {
              conversationId = compacted.newConversationId
              enqueue({
                type: 'conversation_compacted',
                previousConversationId: compacted.previousConversationId,
                conversationId: compacted.newConversationId,
                convoCost: compacted.costUsd,
              })
            }
          } catch (err) {
            console.warn('[assistant/chat] auto-compact failed:', err)
          }
        }
      } catch (err) {
        if (!req.signal.aborted) {
          void captureAgentError(err, 'agent.chat.stream_error', { conversationId: conversationId ?? undefined })
          enqueue({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      } finally {
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Conversation-Id': conversationId!,
      'X-Personal-Mode': personalMode ? 'true' : 'false',
      'X-Business-Id': personalMode ? 'PERSONAL' : (businessId ?? 'ALMA_LIFESTYLE'),
    },
  })
}
