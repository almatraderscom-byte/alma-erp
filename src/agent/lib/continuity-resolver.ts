/**
 * Deterministic continuity resolver (Roadmap 1 Phase 32).
 *
 * ONE conflict rule for "which work does this owner message belong to",
 * replacing the fragmented signals (narrow CONTINUE_RE, prompt notes, model
 * judgment) that produced the "forgot after 2–3 replies" class. The core is a
 * PURE function over explicit state — it runs identically in production, in
 * the replay corpus, and after any process restart or gap (state lives in the
 * focus/run/card/checkpoint tables, never in memory).
 *
 * Resolver rules (roadmap order):
 *   0. listen mode suppresses work resumption (focus is kept, never deleted)
 *   1. an explicit reply to a card binds to THAT exact card
 *   2. a pending card + a decision/answer-shaped message binds to the card
 *   3. an unresolved checkpoint + retry/why-stopped text binds to the checkpoint
 *   4. a clear NEW task parks the active focus (never silently mixed)
 *   5. a continuation/status utterance binds to the active focus when
 *      unambiguous (exactly one active focus)
 *   6. otherwise: none — ask one focused question, never fabricate continuity
 *
 * History/semantic recall may ENRICH the brief downstream but has no input
 * here — by construction it cannot select or mutate a high-risk binding.
 */
import { matchIntentPacks } from '@/agent/tools/state-router'

// ── Text classifiers (pure, Bangla + Banglish + English) ─────────────────────

/**
 * Wide continuation net — the roadmap-target replacement for the narrow
 * CONTINUE_RE. Short confirmations, resume phrasings, and "from where you
 * left off" forms. Length-capped: long messages carry their own intent.
 */
const CONTINUATION_UTTERANCE_RE = new RegExp(
  '^\\s*(' +
    // bare confirmations / short acks (the legacy CONTINUE_RE set)
    '(হ্যাঁ|হ্যা|হুম|hm+|ha|hae|hmm+|ok(ay)?|আচ্ছা|accha|achha|ঠিক আছে|thik\\s*ache|ji|জি|yes|না|na|cancel|বাতিল( করো| কর)?)' +
    '|' +
    // continue / resume verbs
    '((continue|resume|চালিয়ে যাও|চালাও|chaliye\\s*jao|chalao|agao|আগাও|koro|করো|kor|কর)( .{0,24})?)' +
    '|' +
    // "then / next / after that"
    '((tarpor|tarpore|তারপর|erpor|এরপর|then|next|porer(ta)?|পরেরটা)\\s*\\??)' +
    '|' +
    // reference to the prior thing: "ওটাই করো", "oi kaj ta ses koro", "baki ta koro"
    '((oita|ota|ওটা(ই)?|oi\\s*kaj(\\s*ta)?|ঐ কাজ|আগের(টা|টার)?|ager\\s*tar?|agertar?|baki\\s*ta|বাকিটা|baki)(\\s.{0,24})?)' +
    '|' +
    // "from where you were/left off"
    '((jekhane|যেখানে)\\s*(chile|ছিলে|silam|ছিলাম).{0,30})' +
  ')\\s*[!.?,।]*\\s*$',
  'i',
)

/** Max length for a continuation-shaped message (longer = own intent). */
const CONTINUATION_MAX = 48

export function isContinuationUtterance(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || t.length > CONTINUATION_MAX) return false
  return CONTINUATION_UTTERANCE_RE.test(t)
}

/**
 * Status question about in-flight work: "ki holo?", "post ta koi?",
 * "ki obostha oi kajer?", "পোস্ট হয়েছে?", "আমরা কোথায় ছিলাম?".
 */
const STATUS_QUERY_RE = new RegExp(
  '(ki\\s*(holo|hoilo|hlo|obostha|obosta|khobor|hocche|hoise|hoyeche|update|ho)\\b)' +
  '|(কি\\s*(হলো|হয়েছে|অবস্থা|খবর|হচ্ছে|আপডেট))' +
  '|(\\b(koi|kothay)\\b|কই|কোথায়)' +
  '|(hoise|hoyeche|হয়েছে|হইছে)\\s*\\??\\s*$' +
  '|(obostha|অবস্থা|খবর|khobor|status|স্ট্যাটাস)' +
  '|((kothay|কোথায়)\\s*(chilam|ছিলাম|chile|ছিলে))' +
  '|((atke|আটকে)\\s*(ache|আছে))',
  'i',
)

export function isStatusQuery(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t || t.length > 64) return false
  return STATUS_QUERY_RE.test(t)
}

/** Retry / run-again text: "abar try koro", "আবার চালাও", "retry". */
const RETRY_RE = /(abar|আবার)\s*(try|chala|চালা|koro|কর)|\bretry\b|resume|আবার\s*কর/i

export function isRetryText(text: string): boolean {
  return RETRY_RE.test((text ?? '').trim())
}

/** "Why did it stop / what went wrong" text. */
const WHY_STOPPED_RE =
  /(থামলো|থামল|thamlo|bondho|বন্ধ|atke|আটকে|আটকাল)\s*(keno|কেন|ache keno|আছে কেন)?|keno\s*(thamlo|bondho|atke)|ki\s*(hoyechilo|hoisilo|problem|সমস্যা)|কী\s*সমস্যা/i

export function isWhyStoppedText(text: string): boolean {
  return WHY_STOPPED_RE.test((text ?? '').trim())
}

/** Approve/reject/revise/answer shapes for a pending card. */
const CARD_DECISION_RE =
  /^(approve|reject|confirm|cancel|বাতিল|না|হ্যাঁ|হ্যা|ok(ay)?|ji|জি|yes|no)\b|approve|অনুমোদন|বাতিল|reject/i

export function isCardDecisionText(text: string): boolean {
  const t = (text ?? '').trim()
  return t.length > 0 && t.length <= 64 && CARD_DECISION_RE.test(t)
}

/**
 * Token overlap between a short message and the focus goal/kind — catches
 * "post ta koi?" against goal "নতুন পাঞ্জাবির ফেসবুক পোস্ট". Deterministic:
 * ≥1 shared content token of length ≥3 (Bangla or Latin, case-folded).
 */
export function referencesFocus(text: string, focus: { goal: string; kind: string }): boolean {
  // \p{M} keeps Bangla vowel signs/virama attached — without it "পোস্ট"
  // shreds into sub-3-char fragments and every Bangla overlap check dies.
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/[^\p{L}\p{M}\p{N}]+/u)
        .filter((w) => w.length >= 3),
    )
  const t = tokens(text)
  if (t.size === 0) return false
  const g = tokens(`${focus.goal} ${focus.kind.replace(/_/g, ' ')}`)
  for (const w of t) {
    if (g.has(w)) return true
    // Bangla/Banglish stem tolerance: "পোস্টে"/"posts" ↔ "পোস্ট"/"post".
    for (const gw of g) {
      if (gw.length >= 3 && (w.startsWith(gw) || gw.startsWith(w))) return true
    }
  }
  return false
}

/**
 * A clear NEW task: carries its own domain intent (pack hit) AND is not a
 * continuation/status/decision shape. matchIntentPacks is the same pure
 * signal the state router uses for tool selection.
 */
export function isClearNewTask(text: string): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (isContinuationUtterance(t) || isStatusQuery(t) || isRetryText(t) || isWhyStoppedText(t)) return false
  return matchIntentPacks(t).length > 0
}

/**
 * Imperative WORK verb — the signal that a new-domain message is a real task
 * handoff (parks the active focus) rather than a passing side-question
 * ("lunch e ki khawa jay bolo to") that should leave the focus active.
 * Deliberately excludes pure tell-me verbs (bolo/জানাও) — informational.
 */
const IMPERATIVE_TASK_RE =
  /(banao|banaw|বানাও|baniye|করে\s*(দাও|দে)|kore\s*(dao|de)|koro|করো|\bkor\b|pathao|পাঠাও|likhe\s*(dao|de)|লিখে\s*দাও|lekho|লেখো|chalao|চালাও|ready\s*(koro|kor)|রেডি\s*(করো|কর)|\bdao\b|দাও|\bdio\b|দিও|dekho|দেখো|dekhao|দেখাও|research\s*koro|থামাও|শুরু\s*করো)/i

export function isImperativeTask(text: string): boolean {
  return IMPERATIVE_TASK_RE.test((text ?? '').trim())
}

// ── The pure decision core ───────────────────────────────────────────────────

export type ContinuityBinding = 'active_focus' | 'pending_card' | 'checkpoint' | 'new_task' | 'none'

export interface FocusLite {
  id?: string
  goal: string
  kind: string
  status: 'active' | 'parked' | 'awaiting_owner'
  currentStep?: string | null
  completedSteps?: string[]
  lastEffectId?: string | null
}

export interface ContinuityInput {
  text: string
  /** Listen mode already resolved by the head router (tier 'personal'). */
  listenMode: boolean
  /** Explicit card reference on the incoming message (tap/reply metadata). */
  replyToCardId?: string | null
  pendingCards: Array<{ id: string; kind: 'ask_card' | 'approval'; actionType?: string | null }>
  activeFocus: FocusLite | null
  parkedFocuses?: FocusLite[]
  checkpoints: Array<{ taskRef?: string; taskType: string; step: string; failureClass?: string }>
}

export interface ContinuityDecision {
  binding: ContinuityBinding
  action: 'resume' | 'answer_card' | 'retry' | 'explain_stop' | 'park_and_start' | 'clarify' | 'listen' | 'proceed'
  cardId?: string
  checkpointTaskRef?: string
  focusId?: string
  /** Verified effects that must NOT be repeated on resume (from the focus). */
  forbiddenEffects: string[]
  /** One-line machine reason — logged on the route span. */
  reason: string
}

export function resolveContinuityDecision(input: ContinuityInput): ContinuityDecision {
  const text = (input.text ?? '').trim()
  const forbidden = input.activeFocus?.completedSteps ?? []
  const base = { forbiddenEffects: forbidden }

  // 0. Listen mode: keep every focus, resume nothing.
  if (input.listenMode) {
    return { ...base, binding: 'none', action: 'listen', reason: 'listen_mode_suppresses_work' }
  }

  // 1. Explicit reply-to card wins over everything.
  if (input.replyToCardId) {
    const card = input.pendingCards.find((c) => c.id === input.replyToCardId)
    if (card) {
      return { ...base, binding: 'pending_card', action: 'answer_card', cardId: card.id, reason: 'explicit_reply_to_card' }
    }
  }

  // 2. A pending card + decision/answer-shaped or status message → that card.
  //    (The blocked reason for "kaj ta atke ache keno?" IS the waiting card.)
  if (input.pendingCards.length > 0) {
    const card = input.pendingCards[0]
    if (isCardDecisionText(text) || isStatusQuery(text)) {
      return {
        ...base,
        binding: 'pending_card',
        action: isStatusQuery(text) && !isCardDecisionText(text) ? 'explain_stop' : 'answer_card',
        cardId: card.id,
        reason: 'pending_card_decision_or_status',
      }
    }
  }

  // 3. Unresolved checkpoint + retry / why-stopped → that checkpoint.
  if (input.checkpoints.length > 0 && (isRetryText(text) || isWhyStoppedText(text))) {
    const cp = input.checkpoints[0]
    return {
      ...base,
      binding: 'checkpoint',
      action: isWhyStoppedText(text) && !isRetryText(text) ? 'explain_stop' : 'retry',
      checkpointTaskRef: cp.taskRef,
      reason: 'checkpoint_retry_or_explain',
    }
  }

  // 4. Clear new task parks the prior focus — never silently mixed.
  if (isClearNewTask(text)) {
    // …unless the "new" text actually references the active focus's own
    // artifact ("post ta koi?" hits the social pack but is a status ask about
    // the active post run; "oi proposal ta pathao" points at THAT proposal).
    // Status/continuation shapes were already excluded by isClearNewTask;
    // these guards cover short focus-referencing questions and demonstrative
    // references ("oi/ওই/সেটা …") to the established context.
    if (
      input.activeFocus
      && text.length <= 40
      && /\?\s*$/.test(text)
      && referencesFocus(text, input.activeFocus)
    ) {
      return { ...base, binding: 'active_focus', action: 'resume', focusId: input.activeFocus.id, reason: 'short_question_references_active_focus' }
    }
    if (
      input.activeFocus
      && text.length <= 48
      && /(^|\s)(oi|ওই|ঐ|oita|ওটা|sheta|সেটা)(\s|$)/i.test(text)
    ) {
      return { ...base, binding: 'active_focus', action: 'resume', focusId: input.activeFocus.id, reason: 'demonstrative_references_active_focus' }
    }
    // Only an IMPERATIVE new task parks the focus; a passing side-question in
    // another domain is answered without abandoning the work in flight.
    const parks = Boolean(input.activeFocus) && isImperativeTask(text)
    return {
      ...base,
      binding: 'new_task',
      action: parks ? 'park_and_start' : 'proceed',
      reason: parks
        ? 'new_task_parks_active_focus'
        : input.activeFocus ? 'side_question_keeps_focus' : 'new_task_no_prior_focus',
    }
  }

  // 5. Continuation / status / focus-referencing short text → active focus
  //    (only when unambiguous: exactly one active focus).
  if (input.activeFocus) {
    if (
      isContinuationUtterance(text)
      || isStatusQuery(text)
      || isRetryText(text)
      || (text.length <= 40 && referencesFocus(text, input.activeFocus))
    ) {
      return { ...base, binding: 'active_focus', action: 'resume', focusId: input.activeFocus.id, reason: 'continuation_binds_active_focus' }
    }
  }

  // 5a. No ACTIVE focus, but exactly ONE parked/awaiting focus and a strong
  //     continuation ("যেখানে ছিলে সেখান থেকে করো") → resume it. "Only when
  //     unambiguous" (roadmap): two candidates → fall through to clarify.
  const dormant = [...(input.parkedFocuses ?? [])]
  if (!input.activeFocus && dormant.length === 1 && isContinuationUtterance(text)) {
    return { ...base, binding: 'active_focus', action: 'resume', focusId: dormant[0].id, reason: 'continuation_resumes_single_parked_focus' }
  }

  // 5b. Checkpoint exists and the message is a bare continuation (no active
  //     focus took it above) → resume the checkpointed work.
  if (input.checkpoints.length > 0 && (isContinuationUtterance(text) || isStatusQuery(text))) {
    const cp = input.checkpoints[0]
    return { ...base, binding: 'checkpoint', action: 'retry', checkpointTaskRef: cp.taskRef, reason: 'continuation_binds_checkpoint' }
  }

  // 6. Nothing to bind: if the text LOOKS like a continuation, the only honest
  //    move is one focused question — never fabricate continuity.
  if (isContinuationUtterance(text) || isStatusQuery(text)) {
    return { ...base, binding: 'none', action: 'clarify', reason: 'continuation_with_no_open_state' }
  }
  return { ...base, binding: 'none', action: 'proceed', reason: 'no_binding_signals' }
}

// ── Gate + DB wrapper ────────────────────────────────────────────────────────

export type ContinuityResolverMode = 'off' | 'shadow' | 'on'

/**
 * AGENT_CONTINUITY_RESOLVER: 'off' kill switch; 'shadow' decide+log only;
 * 'on' decisions drive binding. Unset → ON in Vercel preview, SHADOW in
 * production (Phase 37 owns the production cutover ladder).
 */
export function continuityResolverMode(
  flag = process.env.AGENT_CONTINUITY_RESOLVER,
  vercelEnv = process.env.VERCEL_ENV,
): ContinuityResolverMode {
  if (flag === 'off' || flag === 'false') return 'off'
  if (flag === 'on' || flag === 'true') return 'on'
  if (flag === 'shadow') return 'shadow'
  return vercelEnv === 'preview' ? 'on' : 'shadow'
}

/**
 * Load the conversation's durable state and resolve this turn's continuity.
 * Read-only + fail-open (null = resolver unavailable, legacy behaviour).
 */
export async function resolveConversationContinuity(opts: {
  conversationId: string
  text: string
  listenMode: boolean
  replyToCardId?: string | null
  surface?: string | null
}): Promise<{ decision: ContinuityDecision; mode: ContinuityResolverMode } | null> {
  const mode = continuityResolverMode()
  if (mode === 'off') return null
  try {
    const [{ getFocusStack }, { prisma }, { listUnresolvedCheckpoints }] = await Promise.all([
      import('@/agent/lib/conversation-focus'),
      import('@/lib/prisma'),
      import('@/agent/lib/checkpoint'),
    ])
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const [stack, pendingActions, askCards, checkpoints] = await Promise.all([
      getFocusStack(opts.conversationId),
      db.agentPendingAction.findMany({
        where: { conversationId: opts.conversationId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, type: true },
      }),
      db.agentAskCard.findMany({
        where: { conversationId: opts.conversationId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true },
      }),
      listUnresolvedCheckpoints(opts.conversationId),
    ])
    const decision = resolveContinuityDecision({
      text: opts.text,
      listenMode: opts.listenMode,
      replyToCardId: opts.replyToCardId ?? null,
      pendingCards: [
        ...(askCards as Array<{ id: string }>).map((c) => ({ id: c.id, kind: 'ask_card' as const })),
        ...(pendingActions as Array<{ id: string; type: string }>).map((c) => ({
          id: c.id,
          kind: 'approval' as const,
          actionType: c.type,
        })),
      ],
      activeFocus: stack.active
        ? {
            id: stack.active.id,
            goal: stack.active.goal,
            kind: stack.active.kind,
            status: 'active',
            currentStep: stack.active.currentStep,
            completedSteps: stack.active.completedSteps,
            lastEffectId: stack.active.lastEffectId,
          }
        : null,
      parkedFocuses: stack.parked.map((f) => ({ id: f.id, goal: f.goal, kind: f.kind, status: 'parked' as const })),
      checkpoints: (checkpoints as Array<{ checkpoint: { taskRef: string; taskType: string; currentStep?: string } }>).map(
        (c) => ({
          taskRef: c.checkpoint.taskRef,
          taskType: c.checkpoint.taskType,
          step: c.checkpoint.currentStep ?? 'unknown',
        }),
      ),
    })
    return { decision, mode }
  } catch (err) {
    console.warn('[continuity-resolver] failed open:', err instanceof Error ? err.message : err)
    return null
  }
}
