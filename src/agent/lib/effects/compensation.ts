/**
 * Phase 53 — guarded compensation (undo as a NEW effect, never a raw rollback).
 *
 * Undoing a succeeded effect is itself an external effect: it goes through the
 * same envelope + executeEffect machinery (exactly-once, ledgered, verified).
 * The original run transitions succeeded → compensating → compensated only
 * when the compensating run verifiably succeeds.
 */
import { buildActionEnvelope, signEnvelope } from '@/agent/lib/policy/capability-token'
import { defaultEffectDb, type ActionRunRow, type EffectDb } from './effect-ledger'
import { executeEffect, transitionActionRun, type EffectOutcome, type EffectResultLike } from './action-run'

export interface CompensationRequest {
  /** The succeeded run to undo. */
  run: ActionRunRow
  /** The inverse operation. */
  undo: {
    tool: string
    input: Record<string, unknown>
    execute: (info: { idempotencyKey: string; attempt: number }) => Promise<EffectResultLike>
    verify?: (result: EffectResultLike) => Promise<unknown | null>
  }
  /** Who asked for the undo (owner by default — undo is owner-initiated). */
  actor?: string
  db?: EffectDb
}

export interface CompensationOutcome {
  ok: boolean
  originalState: string
  compensationRun?: EffectOutcome
  error?: string
}

export async function compensateEffect(req: CompensationRequest): Promise<CompensationOutcome> {
  const db = req.db ?? defaultEffectDb()
  const { run } = req

  if (run.state !== 'succeeded' && run.state !== 'unknown_effect') {
    return { ok: false, originalState: run.state, error: `only succeeded/unknown effects can be compensated (state=${run.state})` }
  }

  const compensating = await transitionActionRun(db, run, 'compensating', {
    kind: 'compensation',
    payload: { undoTool: req.undo.tool },
  })
  if (!compensating) {
    return { ok: false, originalState: run.state, error: 'concurrent transition — compensation not started' }
  }

  // The undo is a NEW guarded effect with its own envelope + idempotency key.
  const envelope = signEnvelope(
    buildActionEnvelope({
      actor: req.actor ?? 'owner',
      surface: (run.surface as 'owner' | 'cs' | 'scheduler' | 'worker') ?? 'owner',
      instructionOrigin: 'owner_direct',
      tool: req.undo.tool,
      input: req.undo.input,
      riskTier: (run.riskTier as 'R0' | 'R1' | 'R2' | 'R3' | 'R4') ?? 'R2',
      conversationId: run.conversationId ?? undefined,
      turnId: run.turnId ? `${run.turnId}:undo:${run.id}` : `undo:${run.id}`,
      businessId: run.businessId ?? undefined,
    }),
  )

  const undoOutcome = await executeEffect({
    envelope,
    input: req.undo.input,
    execute: req.undo.execute,
    verify: req.undo.verify,
    db,
  })

  // Link the compensating run to the original.
  await db.agentActionRun.updateMany({ where: { id: undoOutcome.runId }, data: { compensationOfId: run.id } })

  if (undoOutcome.ok) {
    const fresh = await db.agentActionRun.findUnique({ where: { id: run.id } })
    if (fresh && fresh.state === 'compensating') {
      await transitionActionRun(db, fresh, 'compensated', {
        kind: 'compensation',
        payload: { compensationRunId: undoOutcome.runId },
      })
    }
    return { ok: true, originalState: 'compensated', compensationRun: undoOutcome }
  }

  // Undo failed/unknown — the original is now in an uncertain compensating
  // state; surface it honestly (owner-visible) instead of guessing.
  return {
    ok: false,
    originalState: 'compensating',
    compensationRun: undoOutcome,
    error: undoOutcome.error ?? 'compensation effect failed',
  }
}
