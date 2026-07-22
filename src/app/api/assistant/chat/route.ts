import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled, requireAnthropicApiKey, requireModelProviderKey } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { runOwnerTurn } from '@/agent/lib/models/run-owner-turn'
import { assertModelOverrideNotAllowed } from '@/agent/lib/models/guard'
import { AUTO_MODEL_ID, DEFAULT_MODEL_ID, isSelectableModelId, isKnownModelId } from '@/agent/lib/models/registry'
import { getDefaultHeadModelId } from '@/agent/lib/models/routing-config'
import { describeAttachments, hasVisualAttachment, buildVisionNoteBlock } from '@/agent/lib/attachment-vision'
import { touchConversationActivity } from '@/agent/lib/conversation-activity'
import { setOwnerSessionConversation } from '@/agent/lib/owner-session'
import { embedMessageInBackground } from '@/agent/lib/message-recall'
import { ASSISTANT_CHAT_RATE_LIMIT_PER_MIN } from '@/agent/lib/constants'
import { checkAssistantChatRateLimit } from '@/lib/assistant-rate-limit'
import { captureAgentError } from '@/agent/lib/sentry'
import {
  claimContinuationTurn,
  claimTurnForRequest,
  createTurn,
  finalizeTurnIfRunning,
  isRunningTurnForConversation,
  findOrCreateTurnByClientMessageId,
  findTurnByClientMessageId,
  getTurnSnapshot,
  linkTurnUserMessage,
  linkTurnAssistantMessage,
} from '@/agent/lib/turn-status'
import { createTurnEventPublisher } from '@/agent/lib/turn-events'
import { claimTurnSteeringMessages } from '@/agent/lib/turn-steering'
import { enqueueAgentContinuation } from '@/agent/lib/approval-continuation'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { notifyOwnerIfAway } from '@/agent/lib/notify-owner'
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
import { shouldPersistIncomingMessage } from '@/agent/lib/continuation-policy'

export const runtime = 'nodejs'
// 800s (Pro plan + Fluid compute; Vercel allows up to 1800s). Raised from 300s
// on 2026-07-14 (owner confirmed Pro) so long browser/content turns stop dying
// at the old ceiling. The effective turn deadline is still AGENT_TURN_HARD_CAP_MS
// (default 280s) clamped ≥20s under this — set the env to 780000 to use the room.
export const maxDuration = 800

interface FileRef { bucket: string; path: string; mediaType: string }

interface ChatBody {
  conversationId?: string
  message?: string
  files?: FileRef[]
  projectId?: string
  personalMode?: boolean
  source?: string
  /** Set by the voice session — the reply is read aloud (TTS), so the head should
   *  answer TTS-friendly and hand money/irreversible confirmations off to a tap. */
  voice?: boolean
  /** Owner's head-model choice for a NEW web conversation: a real model id or 'auto'. */
  modelId?: string
  /** A2: set by the VPS worker when running an enqueued turn — the turn row the
   * enqueue route already created. Reused instead of creating a second one, and
   * (for a web conversation) it authorizes the internal call. */
  turnId?: string
  /** Phase 3 idempotency key (client-generated UUID): one key → at most one
   * stored owner message and one turn, however many times the client retries. */
  clientMessageId?: string
  /** AGENT-IOS-001 — the tapped ask-card's id: binds this message (the option
   * text) to the EXACT question server-side, no text-match guessing. */
  askCardId?: string
  /** Stable id shared by the direct web send and its VPS fallback. */
  clientRequestId?: string
  /** Structured, owner-session-only continuation. Never stored as a user message. */
  autoContinueFromTurnId?: string
  /** Server/worker continuation note. Control context, never owner-authored chat. */
  internalControl?: boolean
  /**
   * Model-upgrade approval resume: the previous turn paused on a
   * `model_switch_required` card. This re-runs the SAME turn (no new user message)
   * either on the premium model (approve) or on the cheap fallback (decline).
   */
  resume?: { approve: boolean; rememberChoice?: boolean; fallbackModelId?: string }
  /**
   * Telegram reply-threading: the verbatim text of the message the owner tapped
   * "reply" on. When notifications interleave in the Telegram chat, the owner's
   * reply could be aimed at an older card/notification; this carries that anchor
   * so the agent binds to the right topic instead of the latest one. Set only by
   * the VPS worker (internal call). Injected as quoted context into the user turn.
   */
  replyToText?: string
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

  // Owner rule 2026-07-18: the owner's chosen head model runs as head and does ALL
  // the work (Gemini head off, Grok 4.20 the default). New/unpinned conversations +
  // Telegram fall back to this KV-tuned default instead of Sonnet/auto. Picking a
  // concrete model in the selector still overrides it; picking 'auto' restores the
  // cheap cost-routing for that conversation.
  const defaultHeadModelId = await getDefaultHeadModelId()

  if (!isInternalCall) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  } else {
    const keyMissing = requireAnthropicApiKey()
    if (keyMissing) return keyMissing
  }

  // Model-upgrade approval resume (owner-only; needs an existing conversation).
  // No new user message is stored — it re-runs the turn already in the thread.
  const resume =
    !isInternalCall && body.resume && typeof body.conversationId === 'string'
      ? body.resume
      : null
  const autoContinueFromTurnId =
    !isInternalCall
    && typeof body.conversationId === 'string'
    && typeof body.autoContinueFromTurnId === 'string'
      ? body.autoContinueFromTurnId.trim()
      : ''
  const clientRequestId =
    typeof body.clientRequestId === 'string' && /^[A-Za-z0-9_-]{8,100}$/.test(body.clientRequestId.trim())
      ? body.clientRequestId.trim()
      : null

  const message = typeof body.message === 'string' ? body.message.trim() : ''
  const internalControl = isInternalCall && body.internalControl === true
  // Attached files (image/PDF) make a caption-less turn valid — Claude.ai lets you
  // send an image with no text. Parse them up-front so the guard allows an
  // image-only message instead of rejecting it as `message_required`.
  const files: FileRef[] = Array.isArray(body.files)
    ? body.files.filter((f) => f && typeof f.path === 'string' && typeof f.mediaType === 'string')
    : []
  if (!message && !resume && !autoContinueFromTurnId && files.length === 0) {
    return Response.json({ error: 'message_required' }, { status: 400 })
  }

  // Telegram reply-threading anchor (internal/worker calls only). Capped to keep
  // the quoted context small; injected into the stored user turn below so the
  // agent re-anchors to the replied-to topic rather than the most recent one.
  const replyToText = isInternalCall && typeof body.replyToText === 'string'
    ? body.replyToText.trim().slice(0, 500)
    : ''

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

  // Roadmap Phase 3 — client idempotency key. A retry (timeout / reconnect /
  // watchdog fallback) with the same clientMessageId must OBSERVE the existing
  // turn, never store the message or execute the work again. Checked before
  // conversation creation so a fresh-chat retry can't orphan a new conversation.
  const clientMessageId =
    !isInternalCall && typeof body.clientMessageId === 'string' && body.clientMessageId.trim()
      ? body.clientMessageId.trim().slice(0, 64)
      : null

  // AGENT-IOS-001 (client side, additive): an ask-card option tap carries the
  // tapped card's id, so the turn binds the answer to the EXACT question without
  // text-match guessing. Stored as a marker block on the user message row —
  // durable across the direct path AND the VPS worker replay (internal calls
  // forward it in the job body). Clients that don't send it lose nothing.
  const askCardRef =
    typeof body.askCardId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(body.askCardId.trim())
      ? body.askCardId.trim()
      : null
  if (clientMessageId) {
    const dup = await findTurnByClientMessageId(clientMessageId)
    if (dup) {
      return Response.json({
        duplicate: true,
        turnId: dup.id,
        conversationId: dup.conversationId,
        status: dup.status,
        lastSeq: dup.lastSeq,
        userMessageId: dup.userMessageId,
        assistantMessageId: dup.assistantMessageId,
      }, { status: 202 })
    }
  }

  let conversationId = typeof body.conversationId === 'string' ? body.conversationId : null
  let convSource: string | null = null
  let convProjectId: string | null = null
  let projectSystemInstructions: string | null = null
  let personalMode = body.personalMode === true
  let requestedProjectId = typeof body.projectId === 'string' ? body.projectId : null
  // Business scope for the turn — resolved from project or conversation row.
  let businessId: AgentBusinessId | null = null
  let conversationModelId: string = DEFAULT_MODEL_ID
  let claimedRequestTurnId: string | null = null

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

  // Set inside the persistence block; linked onto the turn row after creation.
  let savedUserMessageId: string | null = null
  let alreadyStoredUserMessageId: string | null = null

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
      convSource = conv.source ?? null
      convProjectId = conv.projectId ?? null
      if (isInternalCall && conv.source !== 'telegram') {
        // Channel isolation: a Telegram message must NEVER write into a web/app
        // conversation — Telegram has its own separate daily session. The only
        // internal call allowed to touch a non-telegram conversation is the VPS
        // worker running an owner WEB turn via the long-agent-task queue, which
        // proves authorization by presenting the turnId the enqueue route created.
        const workerTurnOk =
          typeof body.turnId === 'string'
          && (await isRunningTurnForConversation(body.turnId, conversationId))
        if (!workerTurnOk) {
          return Response.json({ error: 'forbidden_conversation' }, { status: 403 })
        }
      }
      conversationModelId = conv.modelId ?? defaultHeadModelId
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
      convSource = source
      convProjectId = personalMode ? requestedProjectId : (requestedProjectId ?? null)
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
        // New conversation persists the owner's pick; with no explicit pick BOTH web
        // and Telegram default to the owner's head model (Grok) so it does all the work.
        conversationModelId = isInternalCall ? defaultHeadModelId : (ownerSelectedModelId ?? defaultHeadModelId)
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

    // Internal worker run of an EXISTING turn whose owner message was already
    // stored by the direct attempt: do not store it again (roadmap invariant 1 —
    // one clientMessageId → one owner message, whatever path re-runs the turn).
    if (isInternalCall && typeof body.turnId === 'string' && body.turnId) {
      const snap = await getTurnSnapshot(body.turnId)
      if (snap?.userMessageId) alreadyStoredUserMessageId = snap.userMessageId
    }

    // Exactly-once claim BEFORE persisting the owner message or executing tools.
    // If the 15s VPS fallback already won this request id, this direct path exits
    // without creating another user row or running the task a second time.
    if (!isInternalCall && !resume && !autoContinueFromTurnId && clientRequestId) {
      const claim = await claimTurnForRequest(conversationId, clientRequestId)
      if (!claim.claimed) {
        return Response.json(
          { error: 'request_already_claimed', turnId: claim.turnId, status: claim.status, conversationId },
          { status: 409 },
        )
      }
      claimedRequestTurnId = claim.turnId
    }

    // Resume (model-upgrade approval) re-runs the SAME turn already in the thread —
    // the owner's question is already stored, so we DON'T persist another user message.
    // Structured auto-continuation is also server state, never owner-authored text.
    if (
      !alreadyStoredUserMessageId
      && shouldPersistIncomingMessage({
        isResume: Boolean(resume),
        autoContinueFromTurnId: autoContinueFromTurnId || null,
        internalControl,
      })
    ) {
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
        // Reply-threading anchor: prepend the replied-to message as quoted context so
        // the agent answers the right (possibly older) topic when notifications
        // interleave. Kept on the stored content (not the title) so history + recall
        // both carry the anchor; the conversation title above stays clean.
        {
          type: 'text',
          text: replyToText
            ? `[বস আপনার আগের এই মেসেজের রিপ্লাই দিয়ে লিখছেন — এই প্রসঙ্গেই উত্তর দিন:\n"${replyToText}"]\n\n${message}`
            : message,
        },
        // AGENT-IOS-001 marker — read by run-owner-turn's ask-card resolution;
        // invisible to clients and to the model (unknown block types are skipped
        // by dbRowsToNeutral, the presentation builder and both chat clients).
        ...(askCardRef ? [{ type: 'ask_card_ref', askCardId: askCardRef }] : []),
      ]

      // Vision pre-read: an image/PDF is transcribed ONCE by Gemini Flash (cheap) and
      // stored as a text block, so the owner's chosen head model — even a text-only one
      // like DeepSeek — answers about it without switching models or paying Claude's
      // vision price. Failure degrades to an honest note instead of a silent blank.
      if (hasVisualAttachment(files)) {
        const visionText = await describeAttachments(files).catch((err) => {
          console.warn('[assistant/chat] attachment vision failed:', err instanceof Error ? err.message : err)
          return null
        })
        userContent.push(buildVisionNoteBlock(visionText))
      }

      const savedUserMsg = await prisma.agentMessage.create({
        data: {
          conversationId,
          clientRequestId,
          role: 'user',
          content: userContent as unknown as Parameters<typeof prisma.agentMessage.create>[0]['data']['content'],
        },
      })
      savedUserMessageId = savedUserMsg.id
      // B2: embed the owner turn for later semantic recall (best-effort; the SSE
      // turn keeps the lambda alive long enough for this to finish).
      embedMessageInBackground(savedUserMsg.id, userContent)
    }
    await touchConversationActivity(conversationId)

    // Web/app session pointer: keep the owner_web_state pointer (read by the web
    // app on load) aimed at the conversation the owner is actively using on
    // web/app, so a refresh or surface switch resumes the same thread. Telegram is
    // intentionally excluded — its daily session is owned by the worker under a
    // separate key, so the two channels never share a thread. Personal chats
    // update the personal pointer; main business chats (no project) update the
    // business pointer. Project/day-shift/Telegram threads don't move it.
    try {
      if (convSource === 'web') {
        if (personalMode) {
          await setOwnerSessionConversation({ conversationId, personalMode: true })
        } else if (convProjectId == null) {
          await setOwnerSessionConversation({ conversationId, personalMode: false })
        }
      }
    } catch (err) {
      console.warn('[chat] owner-session pointer update failed:', err instanceof Error ? err.message : err)
    }
  } catch (err) {
    console.error('[assistant/chat] persistence failed', err)
    await finalizeTurnIfRunning(claimedRequestTurnId, 'error')
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
    if (providerKeyMissing) {
      await finalizeTurnIfRunning(claimedRequestTurnId, 'error')
      return providerKeyMissing
    }
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
  // The server controller has a hard cap held safely under Vercel maxDuration so
  // the function returns cleanly instead of being killed mid-write. This covers the
  // ~95% case (turns <= cap) surviving a background/close without new infra.
  // Owner-tunable via AGENT_TURN_HARD_CAP_MS: on a Pro plan with Fluid compute,
  // raise `maxDuration` above (Vercel now allows up to 1800s) and set the env to
  // match — long browser/content turns stop dying at the old 280s ceiling. The
  // Math.min guard keeps a mismatched env from ever exceeding the function's
  // real budget (cap always ≥20s under maxDuration for the final persist).
  const TURN_HARD_CAP_MS = Math.min(
    Number(process.env.AGENT_TURN_HARD_CAP_MS) || 280_000,
    (maxDuration - 20) * 1000,
  )
  const turnAbort = new AbortController()
  const turnCapTimer = setTimeout(() => turnAbort.abort(), TURN_HARD_CAP_MS)

  // Durable turn row: lets the client re-sync after backgrounding and gives the
  // Stop button a cross-instance cancel target. Fail-open (null id) if it can't write.
  // A2: a worker-run turn reuses the row the enqueue route already created, so the
  // same turnId flows through the worker's event log and the client's stream.
  // Phase 3: with a clientMessageId the create is idempotent — the DB uniqueness
  // constraint is the guarantee; a concurrent duplicate observes, never re-runs.
  let turnId: string | null
  if (isInternalCall && typeof body.turnId === 'string' && body.turnId) {
    turnId = body.turnId
  } else if (autoContinueFromTurnId) {
    const claim = await claimContinuationTurn(conversationId!, autoContinueFromTurnId)
    if (!claim.claimed || !claim.turnId) {
      clearTimeout(turnCapTimer)
      return Response.json(
        { error: 'continuation_not_eligible', turnId: claim.turnId, status: claim.status },
        { status: 409 },
      )
    }
    turnId = claim.turnId
  } else if (claimedRequestTurnId) {
    turnId = claimedRequestTurnId
  } else if (clientMessageId) {
    const r = await findOrCreateTurnByClientMessageId(conversationId!, clientMessageId, 'inline')
    if (r && !r.created) {
      clearTimeout(turnCapTimer)
      return Response.json({
        duplicate: true,
        turnId: r.turn.id,
        conversationId: r.turn.conversationId,
        status: r.turn.status,
        lastSeq: r.turn.lastSeq,
        userMessageId: r.turn.userMessageId,
        assistantMessageId: r.turn.assistantMessageId,
      }, { status: 202 })
    }
    turnId = r?.turn.id ?? null
  } else {
    turnId = await createTurn(conversationId!, { executionMode: 'inline' })
  }
  if (savedUserMessageId) await linkTurnUserMessage(turnId, savedUserMessageId)

  // Model-upgrade approval resume: re-run the same turn either on the premium model
  // (approve → router re-resolves and approveModelSwitch skips the gate) or pinned to
  // the cheap fallback (decline → run on the model the thread was already using).
  let resumeModelId: string | null = null
  if (resume && !resume.approve) {
    const fb = typeof resume.fallbackModelId === 'string' ? resume.fallbackModelId.trim() : ''
    if (fb && isKnownModelId(fb)) resumeModelId = fb
  }
  if (resume?.approve && resume.rememberChoice && conversationId) {
    // "Don't ask again in this chat" — remember the auto-upgrade is pre-approved.
    try {
      const key = `model_switch_ok:${conversationId}`
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (prisma as any).agentKvSetting.upsert({
        where: { key },
        create: { key, value: '1' },
        update: { value: '1' },
      })
    } catch (err) {
      console.warn('[chat] remember model-switch choice failed:', err instanceof Error ? err.message : err)
    }
  }

  // The owner's chosen head model is kept as-is for image/PDF turns. The attachment
  // was already transcribed by Gemini Flash above and stored as a text block, so a
  // text-only model (DeepSeek) reads it from that description — no model switch, no
  // Claude vision cost.
  // Voice turns: the reply is spoken aloud, so steer the head to a short,
  // TTS-friendly answer and keep money/irreversible actions tap-gated (never let a
  // mis-heard "হ্যাঁ" approve a money move). The head still ACTS by voice for
  // everything its autonomy policy already allows — this only shapes the reply +
  // the confirmation hand-off. Rides the existing projectSystemInstructions carrier.
  const VOICE_TURN_INSTRUCTION =
    '[VOICE MODE — তোমার উত্তর TTS দিয়ে Boss-কে জোরে পড়ে শোনানো হবে; তিনি হ্যান্ডস-ফ্রি।]\n' +
    '- মেসেজটা ভয়েস ট্রান্সক্রিপ্ট — STT-র ভুল থাকতে পারে (শব্দ ভাঙা, বানান এলোমেলো, Banglish মিশ্রণ)। ' +
    'আক্ষরিক শব্দ নয়, প্রসঙ্গ থেকে Boss-এর আসল উদ্দেশ্য ধরো — ChatGPT/Gemini-র ভয়েস মোড যেমন করে। ' +
    'সামান্য অস্পষ্টতা নিজে যুক্তি দিয়ে মিটিয়ে কাজ শেষ করো; শুধু সত্যিই দুই-অর্থ হলে এক লাইনের ছোট প্রশ্ন করো — ' +
    'ভুল কাজ করার চেয়ে এক প্রশ্ন ভালো, কিন্তু অকারণ প্রশ্নে Boss-কে বিরক্ত কোরো না।\n' +
    '- উত্তর ছোট রাখো: ১–৩ বাক্য, কথ্য বাংলা, কোনো markdown/লিংক/বুলেট/টেবিল নয়; সংখ্যা স্বাভাবিকভাবে বলো (যেমন "বারো হাজার পাঁচশো টাকা")।\n' +
    '- টেক্সট চ্যাটের মতোই কাজ করতে পারো — একই autonomy policy মানো; টাইপ করা মেসেজে যা করতে, ভয়েসেও ঠিক তাই করো।\n' +
    '- টাকা বা অপরিবর্তনীয় কাজের জন্য confirm card আগের মতোই বানাও, কিন্তু বলো এক লাইনে: "অ্যাপে Approve-এ ট্যাপ করুন" — মুখের "হ্যাঁ" কখনো টাকার কাজ approve বলে ধরে নিও না; ' +
    'অস্পষ্ট শোনা টাকার অংক/পরিমাণ নিজে অনুমান করে বসিও না — আগে নিশ্চিত হও।\n' +
    '- বাক্য এমনভাবে শেষ করো যেন শুনতে স্বাভাবিক লাগে।'
  const AUTO_CONTINUE_INSTRUCTION =
    '[SYSTEM CONTINUATION — Boss নতুন কোনো message পাঠাননি। আগের turn সত্যিই server deadline-এ থেমেছে এবং persisted continuation claim এই turn-কে একবারের জন্য চালু করেছে।] ' +
    'Unresolved checkpoint থেকে ঠিক পরের ধাপটি ধরো; completed tool/action/artifact আবার চালাবে না। কাজ ইতিমধ্যে complete হলে কোনো tool rerun না করে শুধু স্থির final status দাও।'
  const turnOptions = {
    projectSystemInstructions:
      [
        projectSystemInstructions,
        internalControl
          ? `[INTERNAL WORKFLOW CONTINUATION — this is server control state, NOT a new Boss/user message; never quote it as if Boss wrote it.]\n${message}`
          : null,
        body.voice === true ? VOICE_TURN_INSTRUCTION : null,
        autoContinueFromTurnId ? AUTO_CONTINUE_INSTRUCTION : null,
      ].filter(Boolean).join('\n\n') || null,
    personalMode,
    telegramFastPath,
    businessId,
    modelId: isInternalCall
      ? defaultHeadModelId
      : (resumeModelId ?? conversationModelId),
    signal: turnAbort.signal,
    turnId,
    // Near this moment the turn loop stops offering tools and forces a Bangla
    // progress wrap-up (+ "continue" hint) instead of dying silently at the cap.
    deadlineAt: Date.now() + TURN_HARD_CAP_MS,
    approveModelSwitch: resume?.approve === true,
  }

  async function* runTurn() {
    // ALL turns — owner web AND internal (Telegram / VPS-worker continuation) — go
    // through runOwnerTurn so the head-router's safeties always apply. Internal
    // calls used to invoke runAgentTurn (the native Claude path) directly with
    // DEFAULT_MODEL_ID (Sonnet), which skipped the ANTHROPIC_HEAD_DOWN redirect —
    // every approval-continuation / Telegram turn was still billed at Sonnet rates
    // while the head was supposed to run on Gemini. With a concrete pinned modelId
    // runOwnerTurn does NO triage: it resolves 'explicit' and, when Anthropic is
    // up, delegates to the same runAgentTurn with the same options (behavior
    // preserved); when ANTHROPIC_HEAD_DOWN it transparently redirects to the heavy
    // head (Gemini 3.1 Pro) and applies the owner's model-enabled fallback.
    yield* runOwnerTurn(conversationId!, turnOptions)
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
    let continuationNeeded = false
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
          const doneMessageId = (event as { messageId?: string }).messageId
          if (doneMessageId && turnId) await linkTurnAssistantMessage(turnId, doneMessageId)
          continuationNeeded = event.needContinue === true
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
      // Surface the real cause to stdout (Vercel runtime logs). Previously this only
      // went to Sentry, so a Telegram turn failure showed an opaque 500 with no
      // readable reason in the logs. Include the stack to pinpoint the throw.
      console.error('[assistant/chat] non-stream turn failed:', err instanceof Error ? err.stack ?? err.message : String(err))
    } finally {
      clearTimeout(turnCapTimer)
    }
    await finalizeTurnIfRunning(turnId, errorMsg ? 'error' : 'done', { continuationNeeded })
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
  // Short preview of the reply, for the away-push (ntfy) when the app is closed.
  let replyPreview = ''

  const encoder = new TextEncoder()
  let streamClosed = false
  // Roadmap 3.4 — inline turns write the SAME durable event log the worker does
  // (agent_turn_events + Redis live channel + AgentTurn.lastSeq), so a client that
  // reconnects mid-turn replays from its cursor instead of waiting for polls.
  // Internal (worker-driven) calls skip it: the worker mirrors events itself.
  const durable = !isInternalCall && turnId ? createTurnEventPublisher(turnId) : null
  const stream = new ReadableStream({
    async start(controller) {
      // CRITICAL (owner bug 2026-07-12, "app close = kaj theme jay"): once the
      // client disconnects the stream is canceled, and controller.enqueue() on a
      // canceled stream THROWS — that exception used to escape the event loop
      // below and kill the running turn generator, so closing the app killed the
      // work mid-turn despite the design note above. Events after disconnect are
      // simply dropped; the turn keeps running and persists its reply, and the
      // client re-syncs from the conversation on re-open (A1).
      const enqueue = (evt: unknown) => {
        if (streamClosed || !clientConnected) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`))
        } catch {
          clientConnected = false
        }
      }
      // Live wire + durable log together. The durable write keeps going after the
      // client disconnects — that's the point: replay must have what the dropped
      // socket never delivered.
      const emit = (evt: unknown) => {
        enqueue(evt)
        durable?.emit(evt as { type: string })
      }

      // SSE keepalive — a long tool/sub-agent step can run 30–60s without yielding
      // any event; without traffic an idle proxy/CDN may drop the stream and the
      // client sees "Failed to fetch". Comment frames (": ping") keep it warm and
      // are ignored by the client parser (only "data:" lines are consumed).
      const keepAlive = setInterval(() => {
        if (streamClosed) return
        try { controller.enqueue(encoder.encode(`: ping\n\n`)) } catch { /* stream closed — expected */ }
      }, 10_000)

      emit({ type: 'conversation_id', id: conversationId })
      emit({ type: 'personal_mode', active: personalMode })
      // Give the client the durable turn id so its Stop button can issue a real
      // server-side cancel, and so it can poll this turn's status after re-open.
      if (turnId) emit({ type: 'turn_id', id: turnId })
      try {
        for await (const event of runTurn()) {
          emit(event)
          // App-style push (ntfy) ONLY when the owner is away — suppressed while
          // he's in the app (notifyOwnerIfAway checks app-presence). Telegram turns
          // already push via Telegram, so skip them here.
          if (event.type === 'text_delta' && replyPreview.length < 140) {
            replyPreview += (event as { delta?: string }).delta ?? ''
          } else if (event.type === 'confirm_card' && !isInternalCall) {
            const summary = (event as { summary?: string }).summary
            void notifyOwnerIfAway({
              tier: 2,
              title: 'অনুমোদন দরকার — ALMA Agent',
              message: (summary && summary.slice(0, 200)) || 'একটি অনুমোদন আপনার অপেক্ষায় আছে Boss।',
              category: 'urgent',
              actionUrl: '/agent',
            }).catch(() => {})
          }
          if (event.type === 'done') {
            doneTurnMs = Date.now() - turnStartedAt
            // Terminal linkage (roadmap 3.6): the exact persisted assistant row,
            // so a recovering client fetches one message, not the whole history.
            const doneMessageId = (event as { messageId?: string }).messageId
            if (doneMessageId && turnId) await linkTurnAssistantMessage(turnId, doneMessageId)
            await finalizeTurnIfRunning(turnId, 'done', { continuationNeeded: event.needContinue === true })
            // Close the tiny race where Boss's steer persisted after the model's
            // final in-loop poll but before this terminal transition. The steer
            // endpoint now rejects this finished turn, so anything claimed here
            // is the complete last-moment set. Resume automatically; never lose
            // it and never require Boss to send the same instruction again.
            if (conversationId) {
              const lastMomentSteering = await claimTurnSteeringMessages(turnId, conversationId, new Set())
              if (lastMomentSteering.length > 0) {
                await enqueueAgentContinuation({
                  conversationId,
                  message: lastMomentSteering.map((item) => item.prompt).join('\n\n'),
                  force: true,
                })
              }
            }
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
              emit({
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
          // Also log to stdout so the cause is visible in Vercel runtime logs, not only Sentry.
          console.error('[assistant/chat] stream turn failed:', err instanceof Error ? err.stack ?? err.message : String(err))
          void captureAgentError(err, 'agent.chat.stream_error', { conversationId: conversationId ?? undefined })
          emit({ type: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      } finally {
        streamClosed = true
        clearInterval(keepAlive)
        clearTimeout(turnCapTimer)
        // Flush the durable log before the function freezes (replay completeness).
        try { await durable?.finish() } catch { /* advisory — rows already best-effort */ }
        req.signal.removeEventListener('abort', markDisconnected)
        // Safety net: if the turn ended without done/error (hard-cap timeout or a
        // crash), leave it marked error rather than stuck 'running'. No-op if the
        // turn already reached a terminal status (done / canceled by Stop).
        await finalizeTurnIfRunning(turnId, 'error')
        // Owner backgrounded the app and a SLOW turn still finished unseen → ping
        // Telegram so the answer isn't missed. Both conditions required (>30s AND
        // disconnected) so quick foreground turns never spam.
        if (doneTurnMs > 30_000 && !clientConnected) {
          void sendOwnerText('✅ আপনার আগের প্রশ্নের উত্তরটা তৈরি হয়ে গেছে Boss — অ্যাপ খুললেই দেখতে পাবেন।').catch(() => {})
        }
        // App-style ntfy push when a reply lands while the owner is away (app
        // backgrounded/closed → stream dropped). notifyOwnerIfAway double-checks
        // app-presence so it never fires while he's actually in the app.
        if (doneTurnMs >= 0 && !clientConnected && !isInternalCall) {
          void notifyOwnerIfAway({
            tier: 2,
            title: 'ALMA Agent — উত্তর তৈরি',
            message: replyPreview.trim() || 'আপনার প্রশ্নের উত্তর তৈরি হয়েছে Boss।',
            actionUrl: '/agent',
          }).catch(() => {})
        }
        try { controller.close() } catch { /* already canceled by the client — fine */ }
      }
    },
    cancel() {
      // Consumer (the app) disconnected mid-stream — e.g. iPhone backgrounded.
      // The turn itself keeps running (see enqueue guard above).
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
