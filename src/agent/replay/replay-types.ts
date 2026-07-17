/**
 * Replay corpus v2 types (Roadmap 1, Phase 31 — truth baseline).
 *
 * Extends the Phase 0 ReplayCase (replay-case.ts) with the CONTEXT STATE and
 * DECISION EXPECTATIONS the continuity roadmap needs: what durable state
 * existed before the turn (active workflow, ask card, checkpoint, gap,
 * surface, sticky head), what fake external-effect answers the classifiers
 * should receive, and which concrete decisions the real router/state code is
 * expected to make (fast path, head tier, routine intent, tool packs,
 * continuation binding, resume brief, listen suppression, auto-continue).
 *
 * The runner (run-agent-replay.ts) executes the REAL decision code over these
 * fixtures — fixture-shape validation alone is NOT the eval. Expectations
 * encode the roadmap's DESIRED behaviour; where current code disagrees, that
 * is a *baseline finding* recorded honestly in phase-31-baseline.md, never a
 * reason to weaken the expectation.
 */
import type { ReplayCase } from './replay-case'

/** Replay corpus categories with their Phase 31 minimum counts. */
export const REPLAY_CATEGORIES = {
  continuity: 50,
  tool_selection: 30,
  approval_ask_card: 25,
  personal_listen: 20,
  failure_recovery: 15,
  cross_surface: 10,
} as const

export type ReplayCategory = keyof typeof REPLAY_CATEGORIES

/** Failure classes the roadmap requires the corpus to represent. */
export type ReplayFailureClass =
  | 'provider_error'
  | 'network_loss'
  | 'browser_disconnect'
  | 'vercel_deadline'
  | 'worker_crash'
  | 'rate_limit'
  | 'missing_permission'
  | 'waiting_approval'
  | 'waiting_answer'
  | 'app_close'

export type ReplaySurface = 'web' | 'native' | 'telegram'

/** Durable state that existed BEFORE the replayed turn (all optional). */
export type ReplayContextState = {
  /** Minutes since the previous message in the conversation (drives resume brief). */
  gapMinutes?: number
  /** Surface the owner sends THIS turn from. */
  surface?: ReplaySurface
  /** Surface the previous turns happened on (cross-surface cases). */
  priorSurface?: ReplaySurface
  /** Model id of the last assistant turn (head stickiness). */
  stickyModelId?: string | null
  /** Active workflow run the conversation is bound to, if any. */
  activeWorkflow?: {
    kind: string
    goal: string
    status: 'active' | 'waiting_owner' | 'waiting_worker'
    /** Current template state/step id. */
    state: string
    /** Tool/effect ids already VERIFIED complete — must never re-run. */
    verifiedEffects?: string[]
  }
  /** Unresolved failure checkpoint from a previous turn, if any. */
  checkpoint?: {
    taskType: string
    step: string
    failureClass: ReplayFailureClass
  }
  /** Pending ask/approval card the owner may be answering. */
  pendingCard?: {
    kind: 'ask_card' | 'approval'
    id: string
    /** Approval card type (drives packsForPendingActionType). */
    actionType?: string
    question?: string
  }
  /** Turn-loop facts for failure-recovery cases (shouldAutoContinueTurn). */
  turnOutcome?: {
    deadlineHit: boolean
    hasAskCard: boolean
    tools: Array<{ toolName: string; status: 'success' | 'error' }>
  }
}

/** Deterministic answers the fake external classifiers return in tests. */
export type ReplayFakes = {
  /** What the (mocked) triage classifier answers: light | marketing | heavy. */
  triageTier?: 'light' | 'marketing' | 'heavy'
  /** What the (mocked) personal/emotional classifier answers. */
  personalClassification?: 'personal' | 'work'
}

/**
 * Decision-level expectations checked against REAL code output.
 * Every field is optional — a case only asserts the decisions it is about.
 */
export type ReplayDecisionExpectation = {
  /** classifyHeadFastPath(text) — pure. */
  fastPath?: 'deny_kw' | 'call_intent' | 'personal_hint' | 'marketing_kw' | 'routine_kw' | 'continuation' | null
  /** resolveHeadModelId(...).tier — full head decision (tests wire real fn + fakes). */
  headTier?: 'light' | 'heavy' | 'explicit' | 'marketing' | 'personal'
  /** detectRoutineIntent(text) — null = must NOT hit the routine graph. */
  routineIntent?: string | null
  /** matchIntentPacks(text) must include these packs. */
  packs?: string[]
  /** matchIntentPacks(text) must NOT include these packs. */
  forbiddenPacks?: string[]
  /** isContinuationText(text) — short confirmation carrying no domain. */
  continuationText?: boolean
  /** Desired binding for this turn given the context state. */
  binding?: 'active_workflow' | 'pending_card' | 'checkpoint' | 'new_task' | 'none'
  /** shouldInjectResumeBrief given gapMinutes. */
  resumeBrief?: boolean
  /** Listen mode: business tools must be withheld this turn. */
  listenSuppressed?: boolean
  /** shouldAutoContinueTurn over contextState.turnOutcome. */
  autoContinue?: boolean
  /**
   * True when re-running the turn's work would repeat an already-VERIFIED
   * side effect unless the binding is honoured (repeated-effect risk metric).
   */
  repeatedEffectRisk?: boolean
}

/** One Phase 31 fixture = Phase 0 case + context + fakes + decision expectations. */
export type ReplayCaseV2 = ReplayCase & {
  category: ReplayCategory
  context?: ReplayContextState
  fakes?: ReplayFakes
  expect2: ReplayDecisionExpectation
}

// ── Results ──────────────────────────────────────────────────────────────────

/** Version stamp for the behaviour artifacts the runner exercises. Bump when
 * the decision surface changes (new resolver, new gate) so old baselines are
 * never compared apples-to-oranges. */
export const BEHAVIOR_ARTIFACT_VERSION = 'phase31-v1'

export type ReplayCheckOutcome = {
  check: string
  expected: unknown
  actual: unknown
  pass: boolean
}

export type ReplayCaseResult = {
  id: string
  category: ReplayCategory
  traceId: string
  behaviorVersion: string
  checks: ReplayCheckOutcome[]
  pass: boolean
  /** Names of checks that failed (fast triage for the report). */
  failed: string[]
  /** Checks that could not run in this harness (recorded, not counted). */
  skipped: string[]
}

export type ReplayCategoryMetrics = {
  category: ReplayCategory
  cases: number
  passed: number
  failed: number
  /** check name → { pass, total } */
  byCheck: Record<string, { pass: number; total: number }>
}

export type ReplayReport = {
  behaviorVersion: string
  generatedAt: string
  totalCases: number
  totalPassed: number
  totalFailed: number
  categories: ReplayCategoryMetrics[]
  /** Aggregate decision metrics (recall/precision style). */
  metrics: {
    fastPathAccuracy: number | null
    headTierAccuracy: number | null
    routineIntentAccuracy: number | null
    packRecall: number | null
    packPrecision: number | null
    continuationTextAccuracy: number | null
    bindingAccuracy: number | null
    resumeBriefAccuracy: number | null
    listenSuppressionAccuracy: number | null
    autoContinueAccuracy: number | null
    /** Cases with repeatedEffectRisk expected whose binding check failed. */
    repeatedEffectRiskCount: number
  }
  /** Metrics this harness CANNOT measure (honest deferral, per roadmap). */
  unmeasured: string[]
  results: ReplayCaseResult[]
}

/** Deterministic trace id (no Date.now / randomness — CI-stable). */
export function replayTraceId(caseId: string, behaviorVersion = BEHAVIOR_ARTIFACT_VERSION): string {
  let h = 0
  const s = `${behaviorVersion}:${caseId}`
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0
  }
  return `rt-${(h >>> 0).toString(16).padStart(8, '0')}`
}

/** Validate the v2 extension of a fixture. Returns [] when valid. */
export function validateReplayCaseV2(c: unknown): string[] {
  const errors: string[] = []
  if (typeof c !== 'object' || c === null) return ['case is not an object']
  const rc = c as Record<string, unknown>
  if (!Object.keys(REPLAY_CATEGORIES).includes(String(rc.category))) {
    errors.push(`category must be one of ${Object.keys(REPLAY_CATEGORIES).join(', ')}`)
  }
  const e2 = rc.expect2 as Record<string, unknown> | undefined
  if (!e2 || typeof e2 !== 'object') {
    errors.push('expect2 is required (decision expectations)')
  } else if (Object.keys(e2).length === 0) {
    errors.push('expect2 must assert at least one decision')
  }
  const ctx = rc.context as Record<string, unknown> | undefined
  if (ctx?.gapMinutes !== undefined && (typeof ctx.gapMinutes !== 'number' || ctx.gapMinutes < 0)) {
    errors.push('context.gapMinutes must be a non-negative number')
  }
  return errors
}
