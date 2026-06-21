import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled, requireAnthropicApiKey, requireModelProviderKey } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { runAgentTurn } from '@/agent/lib/core'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import { assertModelOverrideNotAllowed } from '@/agent/lib/models/guard'
import { AUTO_MODEL_ID, DEFAULT_MODEL_ID, isSelectableModelId } from '@/agent/lib/models/registry'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { embedMessageInBackground } from '@/agent/lib/message-recall'
import { ASSISTANT_CHAT_RATE_LIMIT_PER_MIN } from '@/agent/lib/constants'
import { checkAssistantChatRateLimit } from '@/lib/assistant-rate-limit'
import { captureAgentError } from '@/agent/lib/sentry'
import { createTurn, finalizeTurnIfRunning, isRunningTurnForConversation } from '@/agent/lib/turn-status'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
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
  /** Owner's head-model choice for a NEW web conversation: a real model id or 'auto'. */
  modelId?: string
  /** A2: set by the VPS worker when running an enqueued turn — the turn row the
   * enqueue route already created. Reused instead of creating a second one, and
   * (for a web conversation) it authorizes the internal call. */
  turnId?: string
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

  // Owner's head-model choice for a NEW web conversation. 'auto' (or unset) → the
  // per-turn router keeps choosing (routine→DeepSeek, marketing→Qwen, sensitive→Sonnet);
  // a concrete model id → that exact model answers. Telegram/internal never overrides.
  const ownerSelectedModelId =
    !isInternalCall && typeof body.modelId === 'string' && isSelectableModelId(body.modelId.trim())
      ? body.modelId.trim()
      : null

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
        // A2: the VPS worker runs owner web turns via the long-agent-task queue.
        // It's allowed onto a non-telegram conversation only when it presents the
        // turnId the enqueue route created (proves the owner authorized this turn).
        const workerTurnOk =
          typeof body.turnId === 'string'
          && (await isRunningTurnForConversation(body.turnId, conversationId))
        if (!workerTurnOk) {
          return Response.json({ error: 'forbidden_conversation' }, { status: 403 })
        }
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
        // New web conversation persists the owner's pick (or 'auto'); Telegram stays Sonnet.
        conversationModelId = isInternalCall ? DEFAULT_MODEL_ID : (ownerSelectedModelId ?? AUTO_MODEL_ID)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const conv: { id: string } = await (prisma as any).agentConversation.create({
          data: {
            title,
            modelId: conversationModelId,
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

    const savedUserMsg = await prisma.agentMessage.create({
      data: {
        conversationId,
        role: 'user',
        content: userContent as unknown as Parameters<typeof prisma.agentMessage.create>[0]['data']['content'],
      },
    })
    // B2: embed the owner turn for later semantic recall (best-effort; the SSE
    // turn keeps the lambda alive long enough for this to finish).
    embedMessageInBackground(savedUserMsg.id, userContent)
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

  if (!isInternalCall && conversationModelId !== AUTO_MODEL_ID) {
    // 'auto' resolves to a concrete model only inside the turn (head-router), so its
    // provider key is checked there; for a pinned model we can validate up-front.
    const providerKeyMissing = requireModelProviderKey(conversationModelId)
    if (providerKeyMissing) return providerKeyMissing
  }

  const telegramFastPath =
    isInternalCall
    && (body.source === 'telegram' || req.headers.get('x-agent-source') === 'telegram')

  // iPhone fix (backgrounded turn must still finish): do NOT tie the turn to
  // req.signal. On the native app, sending a message then backgrounding the app
  // (home screen) drops the WebView's fetch connection, which aborts req.signal —
  // the model call threw AbortError and run-owner-turn returned WITHOUT saving the
  // assistant reply, so the answer was lost. The turn runs against a server-side
  // controller instead and always persists the reply; the client just re-syncs the
  // conversation when it returns to the foreground (it polls the AgentTurn status).
  //
  // The server controller has a 280s hard cap — under Vercel maxDuration (300s) so
  // the function returns cleanly instead of being killed mid-write. This covers the
  // ~95% case (turns <= ~280s) surviving a background/close without new infra.
  const TURN_HARD_CAP_MS = 280_000
  const turnAbort = new AbortController()
  const turnCapTimer = setTimeout(() => turnAbort.abort(), TURN_HARD_CAP_MS)

  // Durable turn row: lets the client re-sync after backgrounding and gives the
  // Stop button a cross-instance cancel target. Fail-open (null id) if it can't write.
  // A2: a worker-run turn reuses the row the enqueue route already created, so the
  // same turnId flows through the worker's event log and the client's stream.
  const turnId =
    isInternalCall && typeof body.turnId === 'string' && body.turnId
      ? body.turnId
      : await createTurn(conversationId!)

  const turnOptions = {
    projectSystemInstructions,
    personalMode,
    telegramFastPath,
    businessId,
    modelId: isInternalCall ? DEFAULT_MODEL_ID : conversationModelId,
    signal: turnAbort.signal,
    turnId,
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
    } finally {
      clearTimeout(turnCapTimer)
    }
    await finalizeTurnIfRunning(turnId, errorMsg ? 'error' : 'done')
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

  // Client-connection tracking for the background-turn case: when the iPhone app
  // is backgrounded the WebView's fetch is dropped, so req.signal aborts and/or the
  // stream is canceled. We DON'T abort the turn (it runs to completion server-side),
  // but we remember the client left so we can ping the owner on Telegram when a slow
  // turn finishes unseen.
  let clientConnected = true
  const markDisconnected = () => { clientConnected = false }
  req.signal.addEventListener('abort', markDisconnected)
  const turnStartedAt = Date.now()
  let doneTurnMs = -1

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
      // Give the client the durable turn id so its Stop button can issue a real
      // server-side cancel, and so it can poll this turn's status after re-open.
      if (turnId) enqueue({ type: 'turn_id', id: turnId })
      try {
        for await (const event of runTurn()) {
          enqueue(event)
          if (event.type === 'done') {
            doneTurnMs = Date.now() - turnStartedAt
            await finalizeTurnIfRunning(turnId, 'done')
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
          if (event.type === 'error') {
            await finalizeTurnIfRunning(turnId, 'error')
            break
          }
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
        clearTimeout(turnCapTimer)
        req.signal.removeEventListener('abort', markDisconnected)
        // Safety net: if the turn ended without done/error (hard-cap timeout or a
        // crash), leave it marked error rather than stuck 'running'. No-op if the
        // turn already reached a terminal status (done / canceled by Stop).
        await finalizeTurnIfRunning(turnId, 'error')
        // Owner backgrounded the app and a SLOW turn still finished unseen → ping
        // Telegram so the answer isn't missed. Both conditions required (>30s AND
        // disconnected) so quick foreground turns never spam.
        if (doneTurnMs > 30_000 && !clientConnected) {
          void sendOwnerText('✅ আপনার আগের প্রশ্নের উত্তরটা তৈরি হয়ে গেছে স্যার — অ্যাপ খুললেই দেখতে পাবেন।').catch(() => {})
        }
        controller.close()
      }
    },
    cancel() {
      // Consumer (the app) disconnected mid-stream — e.g. iPhone backgrounded.
      clientConnected = false
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
