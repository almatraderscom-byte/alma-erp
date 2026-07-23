/**
 * Phase 53 — the transactional ACTION RUN engine (exactly-once external effects).
 *
 * One AgentActionRun row per intended external effect, keyed by the guard's
 * deterministic idempotency key. Retries, reconnects, model repetition, and
 * worker crashes all collapse onto the same row — the executor function runs
 * AT MOST ONCE per key unless an authoritative reconcile proves the provider
 * never received it.
 *
 * State machine (roadmap Phase 53):
 *   proposed → policy_checked → awaiting_approval | claimed → executing
 *     → verifying → succeeded
 *   repair/terminal: denied, expired, failed_retryable, failed_final,
 *     unknown_effect, compensating, compensated
 *
 * Key invariants:
 *   • Ledger append + state transition share one transaction — ledger failure
 *     aborts the write (fail closed).
 *   • The `executing` transition COMMITS BEFORE dispatch. A crash before that
 *     commit provably never dispatched; a crash after it is UNKNOWN and must
 *     reconcile against the provider — never blind-retry.
 *   • succeeded requires a proof row (independent verify, provider receipt, or
 *     the result envelope as record-grade fallback).
 */
import type { SignedEnvelope } from '@/agent/lib/policy/capability-token'
import { appendLedger, defaultEffectDb, type ActionRunRow, type EffectDb } from './effect-ledger'

// ── Phase 65: effect-engine SELECTION (master switch + per-class canary) ──────
// Replaces the binary "AGENT_EFFECT_ENGINE=true flips ALL write tools at once"
// (the audit's "unreviewed mass cutover" risk). Now:
//   AGENT_EFFECT_ENGINE = off | false | unset → engine OFF (unchanged default)
//                       = on  | true          → ALL writes (back-compat)
//                       = canary              → only classes in
//                                               AGENT_EFFECT_ENGINE_CLASSES
// so ONE internal R1 class can pilot the engine without touching every write.

export interface EffectEngineSelection {
  use: boolean
  reason: string
}

/**
 * Decide whether THIS write should ride the exactly-once effect engine. Pure —
 * env is passed in so it is fully testable. Reads/stages never use the engine.
 */
export function effectEngineSelection(opts: {
  toolMode: 'read' | 'stage' | 'write'
  taskClass?: string
  flag?: string
  canaryClasses?: string
}): EffectEngineSelection {
  if (opts.toolMode !== 'write') return { use: false, reason: 'not_a_write' }
  const flag = (opts.flag ?? '').trim().toLowerCase()
  // Audit P0-4: the exactly-once effect engine is MANDATORY for mutations by
  // default. Unset/empty ⇒ ON; 'off'/'0'/'false' is the explicit owner opt-out;
  // 'canary' keeps the per-task-class pilot mode.
  if (flag === 'off' || flag === '0' || flag === 'false') return { use: false, reason: 'master_off' }
  if (flag === '' || flag === 'on' || flag === 'true') return { use: true, reason: 'master_on' }
  if (flag !== 'canary') return { use: false, reason: 'master_off' }
  const allowed = new Set(
    (opts.canaryClasses ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
  if (opts.taskClass && allowed.has(opts.taskClass)) {
    return { use: true, reason: `canary:${opts.taskClass}` }
  }
  return { use: false, reason: 'canary_class_not_selected' }
}

/** Reads the live env into an effect-engine selection for a write tool. */
export function effectEngineSelectionFromEnv(toolMode: 'read' | 'stage' | 'write', taskClass?: string): EffectEngineSelection {
  // Unit tests have no database: an unset flag stays OFF under vitest so pure
  // executor tests do not require a ledger. Production/dev unset ⇒ ON (P0-4).
  const testDefault = process.env.VITEST || process.env.NODE_ENV === 'test' ? 'off' : undefined
  return effectEngineSelection({
    toolMode,
    taskClass,
    flag: process.env.AGENT_EFFECT_ENGINE ?? testDefault,
    canaryClasses: process.env.AGENT_EFFECT_ENGINE_CLASSES,
  })
}

export const ACTION_RUN_STATES = [
  'proposed',
  'policy_checked',
  'awaiting_approval',
  'claimed',
  'executing',
  'verifying',
  'succeeded',
  'denied',
  'expired',
  'failed_retryable',
  'failed_final',
  'unknown_effect',
  'compensating',
  'compensated',
] as const

export type ActionRunState = (typeof ACTION_RUN_STATES)[number]

/** Legal transitions — anything else is a programming error and must throw. */
export const LEGAL_TRANSITIONS: Record<ActionRunState, readonly ActionRunState[]> = {
  proposed: ['policy_checked', 'denied', 'expired'],
  policy_checked: ['awaiting_approval', 'claimed', 'denied', 'expired'],
  awaiting_approval: ['claimed', 'denied', 'expired'],
  claimed: ['executing', 'denied', 'expired'],
  executing: ['verifying', 'failed_retryable', 'failed_final', 'unknown_effect'],
  verifying: ['succeeded', 'unknown_effect', 'failed_final'],
  succeeded: ['compensating'],
  denied: [],
  expired: [],
  failed_retryable: ['claimed', 'failed_final', 'expired'],
  failed_final: [],
  unknown_effect: ['verifying', 'failed_retryable', 'failed_final', 'compensating'],
  compensating: ['compensated', 'unknown_effect'],
  compensated: [],
}

export function assertLegalTransition(from: ActionRunState, to: ActionRunState): void {
  if (!LEGAL_TRANSITIONS[from]?.includes(to)) {
    throw new Error(`illegal action-run transition ${from} → ${to}`)
  }
}

/**
 * Transition a run with optimistic concurrency (state + stateVersion must
 * match what the caller read) and an atomic ledger append. Returns the fresh
 * row, or null when the compare-and-swap lost (someone else transitioned).
 * Ledger failure throws → transaction aborts → no state change.
 */
export async function transitionActionRun(
  db: EffectDb,
  run: Pick<ActionRunRow, 'id' | 'state' | 'stateVersion'>,
  to: ActionRunState,
  opts: { payload?: unknown; set?: Record<string, unknown>; kind?: 'transition' | 'compensation' } = {},
): Promise<ActionRunRow | null> {
  assertLegalTransition(run.state as ActionRunState, to)
  return db.$transaction(async (tx) => {
    const claimed = await tx.agentActionRun.updateMany({
      where: { id: run.id, state: run.state, stateVersion: run.stateVersion },
      data: { state: to, stateVersion: run.stateVersion + 1, ...(opts.set ?? {}) },
    })
    if (claimed.count === 0) return null
    await appendLedger(tx, run.id, opts.kind ?? 'transition', {
      fromState: run.state,
      toState: to,
      payload: opts.payload,
    })
    return tx.agentActionRun.findUnique({ where: { id: run.id } })
  })
}

// ── Execution API ─────────────────────────────────────────────────────────────

export interface EffectResultLike {
  success: boolean
  data?: unknown
  error?: string
  errorCode?: string
  retryable?: boolean
  /** Provider receipt id when the executor knows it (message id, call sid…). */
  providerRef?: string
}

export interface ExecuteEffectRequest {
  /** Signed action envelope from the Phase 52 guard. */
  envelope: SignedEnvelope
  input: Record<string, unknown>
  /** Performs the external effect. MUST forward idempotencyKey to the provider when supported. */
  execute: (info: { idempotencyKey: string; attempt: number }) => Promise<EffectResultLike>
  /**
   * Independent postcondition check (re-read / authoritative receipt).
   * Return evidence (stored as the proof row) or null when unavailable.
   */
  verify?: (result: EffectResultLike) => Promise<unknown | null>
  /**
   * Authoritative provider-state probe for unknown outcomes (timeout after
   * dispatch). 'not_executed' is the ONLY answer that permits a retry.
   */
  reconcile?: () => Promise<'succeeded' | 'not_executed' | 'unknown'>
  /** Effect requires an explicit approval before execution (awaiting_approval). */
  requiresApproval?: boolean
  costUsd?: number
  moneyTaka?: number
  db?: EffectDb
}

export interface EffectOutcome {
  ok: boolean
  state: ActionRunState
  runId: string
  /** True when a previously completed run's stored result was returned. */
  replayed: boolean
  result?: unknown
  proof?: unknown
  error?: string
  errorCode?: string
}

function outcomeFromRun(run: ActionRunRow, replayed: boolean): EffectOutcome {
  const ok = run.state === 'succeeded' || run.state === 'compensated'
  return {
    ok,
    state: run.state as ActionRunState,
    runId: run.id,
    replayed,
    result: run.result ?? undefined,
    proof: run.proof ?? undefined,
    error: run.error ?? (ok ? undefined : `effect in state ${run.state}`),
    errorCode: ok ? undefined : `effect_${run.state}`,
  }
}

/** Create the durable intent: run row + proposed→policy_checked→(awaiting_approval|claimed) ledger chain, one transaction. */
async function createRun(req: ExecuteEffectRequest, db: EffectDb): Promise<ActionRunRow> {
  const env = req.envelope.envelope
  const initialTarget: ActionRunState = req.requiresApproval ? 'awaiting_approval' : 'claimed'
  return db.$transaction(async (tx) => {
    const run = await tx.agentActionRun.create({
      data: {
        idempotencyKey: env.idempotencyKey,
        effectHash: env.inputHash,
        tool: env.tool,
        surface: env.surface,
        actor: env.actor,
        instructionOrigin: env.instructionOrigin,
        conversationId: env.conversationId ?? null,
        turnId: env.turnId ?? null,
        businessId: env.businessId ?? null,
        riskTier: env.riskTier,
        policyVersion: env.policyVersion,
        approvalRef: env.approvalRef ?? null,
        state: initialTarget,
        input: req.input,
        destination: env.destination ?? null,
        costUsd: req.costUsd ?? null,
        moneyTaka: req.moneyTaka ?? null,
      },
    })
    await appendLedger(tx, run.id, 'transition', { toState: 'proposed', payload: { envelopeSignature: req.envelope.signature } })
    await appendLedger(tx, run.id, 'transition', { fromState: 'proposed', toState: 'policy_checked', payload: { policyVersion: env.policyVersion, riskTier: env.riskTier } })
    await appendLedger(tx, run.id, 'transition', { fromState: 'policy_checked', toState: initialTarget, payload: req.requiresApproval ? { approval: 'pending' } : { approvalRef: env.approvalRef ?? null } })
    return run
  })
}

/** Owner approved an awaiting_approval run (exact payload re-verified by the guard upstream). */
export async function approveActionRun(runId: string, approvalRef: string, db: EffectDb = defaultEffectDb()): Promise<ActionRunRow | null> {
  const run = await db.agentActionRun.findUnique({ where: { id: runId } })
  if (!run || run.state !== 'awaiting_approval') return null
  return transitionActionRun(db, run, 'claimed', { set: { approvalRef }, payload: { approvalRef } })
}

async function markVerifiedSucceeded(
  db: EffectDb,
  run: ActionRunRow,
  result: EffectResultLike,
  req: ExecuteEffectRequest,
): Promise<ActionRunRow | null> {
  // verifying → succeeded with a proof row, atomically.
  let proof: unknown = null
  if (req.verify) {
    try {
      proof = await req.verify(result)
    } catch (err) {
      proof = null
      void err
    }
    if (proof === null || proof === undefined) {
      // Independent proof demanded but unavailable — do NOT claim success.
      return null
    }
  } else {
    proof = result.providerRef
      ? { kind: 'provider_receipt', providerRef: result.providerRef }
      : { kind: 'result_envelope', success: true }
  }

  return db.$transaction(async (tx) => {
    const claimed = await tx.agentActionRun.updateMany({
      where: { id: run.id, state: 'verifying' },
      data: {
        state: 'succeeded',
        stateVersion: run.stateVersion + 1,
        proof,
        result: (result.data ?? null) as object | null,
        providerRef: result.providerRef ?? null,
        error: null,
      },
    })
    if (claimed.count === 0) return null
    await appendLedger(tx, run.id, 'proof', { payload: proof })
    await appendLedger(tx, run.id, 'transition', { fromState: 'verifying', toState: 'succeeded' })
    return tx.agentActionRun.findUnique({ where: { id: run.id } })
  })
}

async function runExecuteFromClaimed(run: ActionRunRow, req: ExecuteEffectRequest, db: EffectDb): Promise<EffectOutcome> {
  // claimed → executing COMMITS FIRST; only then do we dispatch.
  const executing = await transitionActionRun(db, run, 'executing', {
    set: { attempts: run.attempts + 1 },
    payload: { attempt: run.attempts + 1 },
  })
  if (!executing) {
    const fresh = await db.agentActionRun.findUnique({ where: { id: run.id } })
    return fresh ? outcomeFromRun(fresh, true) : { ok: false, state: 'unknown_effect', runId: run.id, replayed: false, error: 'run vanished' }
  }

  let result: EffectResultLike
  try {
    result = await req.execute({ idempotencyKey: executing.idempotencyKey, attempt: executing.attempts })
  } catch (err) {
    // Dispatch happened (or may have) — outcome is UNKNOWN, never blind-retry.
    const unknown = await transitionActionRun(db, executing, 'unknown_effect', {
      set: { error: err instanceof Error ? err.message : String(err) },
      payload: { thrown: true },
    })
    const afterReconcile = await tryReconcile(unknown ?? executing, req, db)
    return afterReconcile
  }

  if (result.success) {
    const verifying = await transitionActionRun(db, executing, 'verifying', {
      set: { providerRef: result.providerRef ?? null },
      payload: result.providerRef ? { providerRef: result.providerRef } : undefined,
    })
    const target = verifying ?? executing
    const succeeded = await markVerifiedSucceeded(db, target, result, req)
    if (succeeded) return outcomeFromRun(succeeded, false)
    const fresh = await db.agentActionRun.findUnique({ where: { id: run.id } })
    return {
      ok: false,
      state: (fresh?.state ?? 'verifying') as ActionRunState,
      runId: run.id,
      replayed: false,
      error: 'postcondition proof unavailable — success not claimed (reconciler will re-verify)',
      errorCode: 'effect_proof_unavailable',
    }
  }

  const retryable = result.retryable === true
  const failed = await transitionActionRun(db, executing, retryable ? 'failed_retryable' : 'failed_final', {
    set: { error: result.error ?? 'effect failed' },
    payload: { errorCode: result.errorCode ?? null, retryable },
  })
  return outcomeFromRun(failed ?? executing, false)
}

async function tryReconcile(run: ActionRunRow, req: ExecuteEffectRequest, db: EffectDb): Promise<EffectOutcome> {
  if (run.state !== 'unknown_effect') {
    const fresh = await db.agentActionRun.findUnique({ where: { id: run.id } })
    if (fresh) run = fresh
  }
  if (run.state !== 'unknown_effect') return outcomeFromRun(run, false)
  if (!req.reconcile) return outcomeFromRun(run, false)

  let verdict: 'succeeded' | 'not_executed' | 'unknown'
  try {
    verdict = await req.reconcile()
  } catch {
    verdict = 'unknown'
  }

  if (verdict === 'succeeded') {
    const verifying = await transitionActionRun(db, run, 'verifying', { payload: { reconcile: 'provider_confirmed' } })
    if (!verifying) return outcomeFromRun(run, false)
    const succeeded = await markVerifiedSucceeded(db, verifying, { success: true, providerRef: verifying.providerRef ?? undefined }, req)
    return succeeded
      ? outcomeFromRun(succeeded, false)
      : { ok: false, state: 'verifying', runId: run.id, replayed: false, error: 'reconciled but proof unavailable', errorCode: 'effect_proof_unavailable' }
  }
  if (verdict === 'not_executed') {
    const retryable = await transitionActionRun(db, run, 'failed_retryable', { payload: { reconcile: 'provider_confirmed_not_executed' } })
    if (retryable) {
      const reclaimed = await transitionActionRun(db, retryable, 'claimed', { payload: { retryAfterReconcile: true } })
      if (reclaimed) return runExecuteFromClaimed(reclaimed, req, db)
    }
    const fresh = await db.agentActionRun.findUnique({ where: { id: run.id } })
    return outcomeFromRun(fresh ?? run, false)
  }
  return outcomeFromRun(run, false) // unknown stays unknown — reconciler cron owns it now
}

/**
 * THE exactly-once entry point. Same idempotency key ⇒ same run: completed
 * runs replay their stored outcome; interrupted runs resume from the last
 * SAFE point; unknown outcomes reconcile against the provider first.
 */
export async function executeEffect(req: ExecuteEffectRequest): Promise<EffectOutcome> {
  const db = req.db ?? defaultEffectDb()
  const key = req.envelope.envelope.idempotencyKey

  const existing = await db.agentActionRun.findUnique({ where: { idempotencyKey: key } })
  if (!existing) {
    const run = await createRun(req, db) // ledger failure here aborts — nothing dispatched
    if (run.state === 'awaiting_approval') {
      return { ok: false, state: 'awaiting_approval', runId: run.id, replayed: false, error: 'awaiting owner approval', errorCode: 'effect_awaiting_approval' }
    }
    return runExecuteFromClaimed(run, req, db)
  }

  const state = existing.state as ActionRunState
  switch (state) {
    case 'succeeded':
    case 'compensated':
    case 'denied':
    case 'expired':
    case 'failed_final':
      return outcomeFromRun(existing, true)
    case 'awaiting_approval':
      return outcomeFromRun(existing, true)
    case 'proposed':
    case 'policy_checked': {
      // Crash before the claim chain finished — safe: nothing dispatched.
      // Walk the legal steps: proposed → policy_checked → claimed.
      let current = existing
      if (current.state === 'proposed') {
        const checked = await transitionActionRun(db, current, 'policy_checked', { payload: { resumed: true } })
        if (!checked) return outcomeFromRun(existing, true)
        current = checked
      }
      const claimed = await transitionActionRun(db, current, 'claimed', { payload: { resumed: true } })
      return claimed ? runExecuteFromClaimed(claimed, req, db) : outcomeFromRun(existing, true)
    }
    case 'claimed':
      // Claimed but never marked executing — provably not dispatched. Execute.
      return runExecuteFromClaimed(existing, req, db)
    case 'failed_retryable': {
      const reclaimed = await transitionActionRun(db, existing, 'claimed', { payload: { retry: true } })
      return reclaimed ? runExecuteFromClaimed(reclaimed, req, db) : outcomeFromRun(existing, true)
    }
    case 'executing': {
      // Crash mid-dispatch — outcome unknown. Mark and reconcile; NEVER re-execute blindly.
      const unknown = await transitionActionRun(db, existing, 'unknown_effect', { payload: { resumedFromExecuting: true } })
      return tryReconcile(unknown ?? existing, req, db)
    }
    case 'unknown_effect':
      return tryReconcile(existing, req, db)
    case 'verifying': {
      // Effect dispatched successfully; only the proof is missing. Re-verify.
      const succeeded = await markVerifiedSucceeded(db, existing, { success: true, providerRef: existing.providerRef ?? undefined }, req)
      return succeeded
        ? outcomeFromRun(succeeded, false)
        : { ok: false, state: 'verifying', runId: existing.id, replayed: true, error: 'proof still unavailable', errorCode: 'effect_proof_unavailable' }
    }
    case 'compensating':
      return outcomeFromRun(existing, true)
    default:
      return outcomeFromRun(existing, true)
  }
}
