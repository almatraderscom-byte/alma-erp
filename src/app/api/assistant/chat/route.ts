import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled, requireAnthropicApiKey, requireModelProviderKey } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { runAgentTurn } from '@/agent/lib/core'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import { assertModelOverrideNotAllowed } from '@/agent/lib/models/guard'
import { DEFAULT_MODEL_ID } from '@/agent/lib/models/registry'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { ASSISTANT_CHAT_RATE_LIMIT_PER_MIN } from '@/agent/lib/constants'
import { checkAssistantChatRateLimit } from '@/lib/assistant-rate-limit'
import { captureAgentError } from '@/agent/lib/sentry'
import { ensurePersonalProject, isPersonalProject } from '@/lib/personal-space'
import { isPersonalSnoozeMessage, setPersonalSnoozeToday } from '@/lib/personal-snooze'
import { PERSONAL_MODE_SENTINEL } from '@/agent/lib/personal-prompt'
import { compactConversationIfNeeded, COMPACT_THRESHOLD_USD } from '@/agent/lib/conversation-compact'
import { isAgentPaused } from '@/agent/lib/agent-controls'
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
  } catch (err) {
    console.warn('[chat] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  let body: ChatBody
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  const isInternalCall = verifyInternalToken(bearerToken)

  if (isInternalCall && typeof (body as { modelId?: string }).modelId === 'string') {
    assertModelOverrideNotAllowed((body as { modelId?: string }).modelId)
  }

  if (!isInternalCall) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  } else {
    const keyMissing = requireAnthropicApiKey()
    if (keyMissing) return keyMissing
  }

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  if (!message) return Response.json({ error: 'message_required' }, { status: 400 })

  // Master pause — owner stopped the agent from the Control Center. Applies to
  // web + Telegram. Fail-open inside isAgentPaused() so a storage glitch can't
  // accidentally lock the agent.
  if (await isAgentPaused()) {
    return Response.json(
      {
        error: 'agent_paused',
        message: '🛑 Agent এখন pause করা আছে (মালিক বন্ধ করেছেন)। Staff Monitor → Control Center থেকে আবার চালু করুন।',
      },
      { status: 423 },
    )
  }

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
  let conversationModelId: string = DEFAULT_MODEL_ID

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
          source: true,
          projectId: true,
          businessId: true,
          modelId: true,
          project: { select: { name: true, systemInstructions: true, businessId: true } },
        },
      })
      if (!conv) return Response.json({ error: 'conversation_not_found' }, { status: 404 })
      if (isInternalCall && conv.source !== 'telegram') {
        return Response.json({ error: 'forbidden_conversation' }, { status: 403 })
      }
      conversationModelId = conv.modelId ?? DEFAULT_MODEL_ID
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
          } catch (err) {
            console.warn('[chat] businessId backfill failed:', err instanceof Error ? err.message : err)
          }
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
      const title = isInternalCall
        ? (personalMode
          ? `Telegram ব্যক্তিগত — ${message.slice(0, 50) || 'চ্যাট'}`
          : `Telegram — ${message.slice(0, 50) || 'চ্যাট'}`)
        : (message.slice(0, 60) || null)

      if (!conversationId) {
        const inherited = personalMode
          ? null
          : await inheritConversationBusinessId(requestedProjectId)
        if (inherited) businessId = inherited
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conv: { id: string } = await (prisma as any).agentConversation.create({
          data: {
            title,
            modelId: DEFAULT_MODEL_ID,
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

  if (!isInternalCall) {
    const providerKeyMissing = requireModelProviderKey(conversationModelId)
    if (providerKeyMissing) return providerKeyMissing
  }

  const telegramFastPath =
    isInternalCall
    && (body.source === 'telegram' || req.headers.get('x-agent-source') === 'telegram')

  const turnOptions = {
    projectSystemInstructions,
    personalMode,
    telegramFastPath,
    businessId,
    modelId: isInternalCall ? DEFAULT_MODEL_ID : conversationModelId,
    signal: req.signal,
  }

  async function* runTurn() {
    if (isInternalCall) {
      yield* runAgentTurn(conversationId!, turnOptions)
    } else {
      yield* runOwnerTurn(conversationId!, turnOptions)
    }
  }

  const streamMode = req.nextUrl.searchParams.get('stream') !== 'false'
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
      for await (const event of runTurn()) {
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
            } catch (err) {
              console.warn('[chat] cost increment failed:', err instanceof Error ? err.message : err)
            }
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

      // SSE keepalive — a long tool/sub-agent step can run 30–60s without yielding
      // any event; without traffic an idle proxy/CDN may drop the stream and the
      // client sees "Failed to fetch". Comment frames (": ping") keep it warm and
      // are ignored by the client parser (only "data:" lines are consumed).
      let streamClosed = false
      const keepAlive = setInterval(() => {
        if (streamClosed) return
        try { controller.enqueue(encoder.encode(`: ping\n\n`)) } catch { /* stream closed — expected */ }
      }, 10_000)

      enqueue({ type: 'conversation_id', id: conversationId })
      enqueue({ type: 'personal_mode', active: personalMode })
      try {
        for await (const event of runTurn()) {
          enqueue(event)
          if (event.type === 'done') {
            const turnCost = (event as { costUsd?: number }).costUsd ?? 0
            if (turnCost > 0 && conversationId) {
              try {
              await prisma.agentConversation.update({
                where: { id: conversationId },
                data: { totalCostUsd: { increment: turnCost } },
              })
            } catch (err) {
              console.warn('[chat] SSE cost increment failed:', err instanceof Error ? err.message : err)
            }
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
        streamClosed = true
        clearInterval(keepAlive)
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
