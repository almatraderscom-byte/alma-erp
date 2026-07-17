/**
 * Phase 53 — the reconciler: unknown outcomes are resolved against the
 * PROVIDER's authoritative state, never by blind retry.
 *
 * Tools register a reconcile probe (e.g. "list messages sent to X in the last
 * hour and look for our idempotency ref"). The reconciler sweeps runs stuck in
 * unknown_effect / stale executing / stale verifying and:
 *   provider says succeeded    → verifying → succeeded (with evidence)
 *   provider says not_executed → failed_retryable (dispatcher may retry)
 *   provider unknown           → stays unknown_effect, owner-visible
 */
import { appendLedger, defaultEffectDb, type ActionRunRow, type EffectDb } from './effect-ledger'
import { transitionActionRun } from './action-run'

export type ReconcileVerdict = 'succeeded' | 'not_executed' | 'unknown'

export type ReconcileProbe = (run: ActionRunRow) => Promise<ReconcileVerdict>

const probes = new Map<string, ReconcileProbe>()

export function registerReconcileProbe(tool: string, probe: ReconcileProbe): void {
  probes.set(tool, probe)
}

export function getReconcileProbe(tool: string): ReconcileProbe | undefined {
  return probes.get(tool)
}

/** Test hook. */
export function clearReconcileProbes(): void {
  probes.clear()
}

export interface ReconcileRunResult {
  runId: string
  before: string
  after: string
  verdict: ReconcileVerdict | 'no_probe'
}

export async function reconcileRun(run: ActionRunRow, db: EffectDb = defaultEffectDb()): Promise<ReconcileRunResult> {
  const probe = probes.get(run.tool)
  if (!probe) {
    return { runId: run.id, before: run.state, after: run.state, verdict: 'no_probe' }
  }

  let verdict: ReconcileVerdict
  try {
    verdict = await probe(run)
  } catch {
    verdict = 'unknown'
  }

  if (verdict === 'succeeded') {
    const verifying =
      run.state === 'verifying' ? run : await transitionActionRun(db, run, 'verifying', { payload: { reconciler: 'provider_confirmed' } })
    if (verifying) {
      await db.$transaction(async (tx) => {
        const claimed = await tx.agentActionRun.updateMany({
          where: { id: run.id, state: 'verifying' },
          data: {
            state: 'succeeded',
            stateVersion: verifying.stateVersion + 1,
            proof: { kind: 'reconciler_provider_state', confirmedAt: new Date().toISOString() },
            error: null,
          },
        })
        if (claimed.count === 1) {
          await appendLedger(tx, run.id, 'proof', { payload: { kind: 'reconciler_provider_state' } })
          await appendLedger(tx, run.id, 'transition', { fromState: 'verifying', toState: 'succeeded' })
        }
      })
      return { runId: run.id, before: run.state, after: 'succeeded', verdict }
    }
    return { runId: run.id, before: run.state, after: run.state, verdict }
  }

  if (verdict === 'not_executed') {
    if (run.state === 'verifying') {
      // Contradiction: a verifying run WAS dispatched successfully. Distrust the probe.
      return { runId: run.id, before: run.state, after: run.state, verdict: 'unknown' }
    }
    const retried = await transitionActionRun(db, run, 'failed_retryable', { payload: { reconciler: 'provider_confirmed_not_executed' } })
    return { runId: run.id, before: run.state, after: retried ? 'failed_retryable' : run.state, verdict }
  }

  return { runId: run.id, before: run.state, after: run.state, verdict }
}

export interface ReconcileSweepResult {
  scanned: number
  resolved: number
  stillUnknown: number
  results: ReconcileRunResult[]
}

/**
 * Sweep runs needing reconciliation:
 *   unknown_effect (any age), and executing/verifying stale beyond opts.staleMs
 *   (a crashed process never came back to finish them).
 */
export async function reconcileStaleRuns(
  opts: { staleMs?: number; limit?: number; now?: Date; db?: EffectDb } = {},
): Promise<ReconcileSweepResult> {
  const db = opts.db ?? defaultEffectDb()
  const now = opts.now ?? new Date()
  const staleBefore = new Date(now.getTime() - (opts.staleMs ?? 10 * 60_000))

  const candidates = await db.agentActionRun.findMany({
    where: {
      OR: [
        { state: 'unknown_effect' },
        { state: 'executing', updatedAt: { lt: staleBefore } },
        { state: 'verifying', updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { updatedAt: 'asc' },
    take: opts.limit ?? 25,
  })

  const results: ReconcileRunResult[] = []
  for (const run of candidates) {
    // Stale executing first moves to unknown_effect (crash marker), then probes.
    let target = run
    if (run.state === 'executing') {
      const marked = await transitionActionRun(db, run, 'unknown_effect', { payload: { reconciler: 'stale_executing' } })
      if (!marked) continue
      target = marked
    }
    results.push(await reconcileRun(target, db))
  }

  return {
    scanned: candidates.length,
    resolved: results.filter((r) => r.after === 'succeeded' || r.after === 'failed_retryable').length,
    stillUnknown: results.filter((r) => r.after === 'unknown_effect').length,
    results,
  }
}
