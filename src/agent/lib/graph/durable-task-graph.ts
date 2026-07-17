/**
 * Phase 54 — the DURABLE TASK GRAPH: one graph-native contract for every task
 * expected to run longer than ~30 seconds. Vercel enqueues and streams status;
 * the VPS worker executes. App/browser disconnects have no effect on server
 * execution; progress is persisted after every node so reconnection (and
 * worker crashes) resume from the last safe point instead of restarting.
 *
 * Persistence rides the EXISTING WorkflowRun tables (kind 'durable_task'):
 *   inputs    — { graph, args } (graph definitions live in code, by name)
 *   facts     — { completed: string[], outputs: {...}, attempts: {...}, blocker }
 *   status    — active | waiting_worker | done | failed | cancelled
 *   state     — queued | running | blocked | finished
 *   leaseUntil / stateVersion — worker lease + optimistic concurrency
 *   WorkflowRunEvent — append-only progress trace (exactly-once replay by id order)
 *
 * Retry separation (roadmap requirement):
 *   read/plan/verify nodes — replay-safe, retried in place with backoff
 *   effect nodes — NEVER replayed directly; they run through the Phase 53
 *     effect engine (executeEffect), so a crash mid-effect resumes as
 *     reconcile-or-replay-stored-outcome, not a second dispatch.
 */
import { prisma } from '@/lib/prisma'
import { buildActionEnvelope, signEnvelope } from '@/agent/lib/policy/capability-token'
import { executeEffect, type EffectOutcome, type EffectResultLike } from '@/agent/lib/effects/action-run'
import type { EffectDb } from '@/agent/lib/effects/effect-ledger'

// ── Structural DB interface (WorkflowRun subset; injectable for tests) ───────

export interface TaskRunRow {
  id: string
  conversationId: string | null
  businessId: string
  kind: string
  goal: string
  status: string
  state: string
  stateVersion: number
  inputs: unknown
  facts: unknown
  artifacts: unknown
  pendingActionId: string | null
  retryCount: number
  leaseUntil: Date | null
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface TaskDb {
  workflowRun: {
    create(args: { data: any }): Promise<TaskRunRow>
    findUnique(args: { where: any }): Promise<TaskRunRow | null>
    findMany(args?: any): Promise<TaskRunRow[]>
    updateMany(args: { where: any; data: any }): Promise<{ count: number }>
  }
  workflowRunEvent: {
    create(args: { data: any }): Promise<unknown>
    findMany(args?: any): Promise<Array<{ id: string; toState: string; detail: unknown; ts: Date }>>
  }
  $transaction<T>(fn: (tx: TaskDb) => Promise<T>): Promise<T>
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export function defaultTaskDb(): TaskDb {
  return prisma as unknown as TaskDb
}

// ── Graph definitions (code-registered; DB stores only the name + args) ──────

export type NodeKind = 'read' | 'plan' | 'verify' | 'effect'

export interface NodeContext {
  runId: string
  args: Record<string, unknown>
  /** Outputs of completed nodes, by node id. */
  outputs: Record<string, unknown>
  /** True when cancellation was requested — long node bodies should poll it. */
  isCancelled: () => Promise<boolean>
  /**
   * The ONLY sanctioned way for a node to perform an external effect: routes
   * through the Phase 53 engine with a node-scoped idempotency key, so a crash
   * mid-effect can never dispatch twice.
   */
  effect: (opts: {
    tool: string
    input: Record<string, unknown>
    riskTier?: 'R1' | 'R2' | 'R3'
    execute: (info: { idempotencyKey: string; attempt: number }) => Promise<EffectResultLike>
    verify?: (result: EffectResultLike) => Promise<unknown | null>
    reconcile?: () => Promise<'succeeded' | 'not_executed' | 'unknown'>
  }) => Promise<EffectOutcome>
}

export interface TaskNodeDef {
  id: string
  kind: NodeKind
  /** Owner-readable label (Bangla welcome) for the progress view. */
  label: string
  run: (ctx: NodeContext) => Promise<unknown>
  /** read/plan/verify only — in-place retries. Effect nodes rely on Phase 53. */
  maxAttempts?: number
  /** Node ids that must complete first (defaults to sequential order). */
  dependsOn?: string[]
  /** Rough duration estimate for the owner-facing ETA range. */
  estimateSec?: number
}

export interface TaskGraphDef {
  name: string
  goal: string
  nodes: TaskNodeDef[]
}

const graphRegistry = new Map<string, TaskGraphDef>()

export function registerTaskGraph(def: TaskGraphDef): void {
  if (def.nodes.length === 0) throw new Error(`graph ${def.name} has no nodes`)
  const ids = new Set<string>()
  for (const n of def.nodes) {
    if (ids.has(n.id)) throw new Error(`graph ${def.name}: duplicate node id ${n.id}`)
    ids.add(n.id)
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`graph ${def.name}: node ${n.id} depends on ${dep} which is not defined before it`)
    }
  }
  graphRegistry.set(def.name, def)
}

export function getTaskGraph(name: string): TaskGraphDef | undefined {
  return graphRegistry.get(name)
}

/** Test hook. */
export function clearTaskGraphs(): void {
  graphRegistry.clear()
}

// ── Facts shape (the durable checkpoint) ─────────────────────────────────────

export interface TaskFacts {
  completed: string[]
  outputs: Record<string, unknown>
  attempts: Record<string, number>
  blocker: string | null
  costUsd: number
}

function readFacts(run: TaskRunRow): TaskFacts {
  const f = (run.facts ?? {}) as Partial<TaskFacts>
  return {
    completed: Array.isArray(f.completed) ? f.completed : [],
    outputs: (f.outputs as Record<string, unknown>) ?? {},
    attempts: (f.attempts as Record<string, number>) ?? {},
    blocker: typeof f.blocker === 'string' ? f.blocker : null,
    costUsd: typeof f.costUsd === 'number' ? f.costUsd : 0,
  }
}

// ── Creation + lease ──────────────────────────────────────────────────────────

export const DURABLE_TASK_KIND = 'durable_task'

export async function createDurableTask(
  opts: {
    graph: string
    args?: Record<string, unknown>
    conversationId?: string
    businessId?: string
    goal?: string
  },
  db: TaskDb = defaultTaskDb(),
): Promise<TaskRunRow> {
  const def = graphRegistry.get(opts.graph)
  if (!def) throw new Error(`unknown task graph: ${opts.graph}`)
  return db.$transaction(async (tx) => {
    const run = await tx.workflowRun.create({
      data: {
        kind: DURABLE_TASK_KIND,
        goal: opts.goal ?? def.goal,
        status: 'active',
        state: 'queued',
        conversationId: opts.conversationId ?? null,
        businessId: opts.businessId ?? 'ALMA_LIFESTYLE',
        inputs: { graph: opts.graph, args: opts.args ?? {} },
        facts: { completed: [], outputs: {}, attempts: {}, blocker: null, costUsd: 0 },
      },
    })
    await tx.workflowRunEvent.create({
      data: { workflowRunId: run.id, toStatus: 'active', toState: 'queued', stateVersion: 1, cause: 'auto', detail: { graph: opts.graph } },
    })
    return run
  })
}

/** CAS lease — duplicate workers cannot hold the same run. */
export async function acquireTaskLease(
  runId: string,
  opts: { owner: string; leaseMs?: number; now?: Date },
  db: TaskDb = defaultTaskDb(),
): Promise<TaskRunRow | null> {
  const now = opts.now ?? new Date()
  const leaseUntil = new Date(now.getTime() + (opts.leaseMs ?? 120_000))
  const claimed = await db.workflowRun.updateMany({
    where: {
      id: runId,
      status: 'active',
      OR: [{ leaseUntil: null }, { leaseUntil: { lt: now } }],
    },
    data: { leaseUntil },
  })
  if (claimed.count === 0) return null
  return db.workflowRun.findUnique({ where: { id: runId } })
}

export async function cancelDurableTask(runId: string, db: TaskDb = defaultTaskDb()): Promise<boolean> {
  const run = await db.workflowRun.findUnique({ where: { id: runId } })
  if (!run || run.status !== 'active') return false
  const updated = await db.workflowRun.updateMany({
    where: { id: runId, status: 'active' },
    data: { status: 'cancelled', state: 'finished', stateVersion: run.stateVersion + 1, completedAt: new Date() },
  })
  if (updated.count === 1) {
    await db.workflowRunEvent.create({
      data: { workflowRunId: runId, fromStatus: 'active', toStatus: 'cancelled', toState: 'finished', stateVersion: run.stateVersion + 1, cause: 'turn', detail: { cancelled: true } },
    })
    return true
  }
  return false
}

// ── Execution ─────────────────────────────────────────────────────────────────

export interface RunTaskOptions {
  owner: string
  leaseMs?: number
  now?: () => Date
  /** In-place retry backoff hook (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>
  /** Effect-engine DB (defaults to the shared prisma client). */
  effectDb?: EffectDb
  /**
   * Crash hook for tests: called after each node checkpoint commit; throwing
   * here simulates the process dying at that exact boundary.
   */
  afterNodeCheckpoint?: (nodeId: string) => void
}

export interface RunTaskResult {
  status: 'done' | 'failed' | 'cancelled' | 'blocked' | 'lease_unavailable'
  completed: string[]
  blocker?: string
}

const DEFAULT_NODE_ATTEMPTS = 3

function backoffMs(attempt: number): number {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1))
}

/**
 * Execute (or RESUME) a durable task run. Safe to call repeatedly and from
 * multiple workers — the lease + per-node checkpoints make it single-flight
 * and crash-resumable. Every meaningful step commits before the next starts.
 */
export async function runDurableTask(
  runId: string,
  opts: RunTaskOptions,
  db: TaskDb = defaultTaskDb(),
): Promise<RunTaskResult> {
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

  const leased = await acquireTaskLease(runId, { owner: opts.owner, leaseMs: opts.leaseMs, now: now() }, db)
  if (!leased) {
    const existing = await db.workflowRun.findUnique({ where: { id: runId } })
    if (existing && existing.status !== 'active') {
      return { status: existing.status === 'done' ? 'done' : existing.status === 'cancelled' ? 'cancelled' : 'failed', completed: readFacts(existing).completed }
    }
    return { status: 'lease_unavailable', completed: [] }
  }

  const inputs = (leased.inputs ?? {}) as { graph?: string; args?: Record<string, unknown> }
  const def = inputs.graph ? graphRegistry.get(inputs.graph) : undefined
  if (!def) {
    await finishRun(db, leased, 'failed', `unknown graph ${inputs.graph ?? '(none)'}`)
    return { status: 'failed', completed: [], blocker: `unknown graph ${inputs.graph ?? '(none)'}` }
  }

  let run = leased
  if (run.state === 'queued' || run.state === 'blocked') {
    const moved = await transitionState(db, run, 'running', { resumed: run.state === 'blocked' })
    if (moved) run = moved
  }

  const args = inputs.args ?? {}

  for (const node of def.nodes) {
    let facts = readFacts(run)
    if (facts.completed.includes(node.id)) continue

    // Dependency check (nodes are stored in topological author order).
    for (const dep of node.dependsOn ?? []) {
      if (!facts.completed.includes(dep)) {
        await blockRun(db, run, `dependency ${dep} incomplete before ${node.id}`)
        return { status: 'blocked', completed: facts.completed, blocker: `dependency ${dep} incomplete` }
      }
    }

    // Cancellation is honoured at every node boundary.
    const fresh = await db.workflowRun.findUnique({ where: { id: runId } })
    if (!fresh || fresh.status === 'cancelled') {
      return { status: 'cancelled', completed: facts.completed }
    }
    run = fresh
    facts = readFacts(run)

    // Heartbeat: extend the lease before each node.
    await db.workflowRun.updateMany({
      where: { id: runId },
      data: { leaseUntil: new Date(now().getTime() + (opts.leaseMs ?? 120_000)) },
    })

    const ctx: NodeContext = {
      runId,
      args,
      outputs: facts.outputs,
      isCancelled: async () => {
        const r = await db.workflowRun.findUnique({ where: { id: runId } })
        return !r || r.status === 'cancelled'
      },
      effect: async (effectOpts) => {
        const envelope = signEnvelope(
          buildActionEnvelope({
            actor: 'agent',
            surface: 'worker',
            instructionOrigin: 'owner_policy',
            tool: effectOpts.tool,
            input: effectOpts.input,
            riskTier: effectOpts.riskTier ?? 'R2',
            conversationId: run.conversationId ?? undefined,
            // Node-scoped key: one effect identity per (run, node).
            turnId: `task:${runId}:${node.id}`,
            businessId: run.businessId,
          }),
        )
        return executeEffect({
          envelope,
          input: effectOpts.input,
          execute: effectOpts.execute,
          verify: effectOpts.verify,
          reconcile: effectOpts.reconcile,
          ...(opts.effectDb ? { db: opts.effectDb } : {}),
        })
      },
    }

    const maxAttempts = node.kind === 'effect' ? 1 : (node.maxAttempts ?? DEFAULT_NODE_ATTEMPTS)
    // Fresh attempt budget per runner invocation — a blocked run that gets
    // retried later must actually retry. facts.attempts is observability only.
    let attempt = 0
    let output: unknown
    let nodeError: string | null = null

    while (attempt < maxAttempts) {
      attempt += 1
      try {
        output = await node.run(ctx)
        nodeError = null
        break
      } catch (err) {
        nodeError = err instanceof Error ? err.message : String(err)
        // Persist the attempt count BEFORE any wait, so a crash mid-backoff
        // does not forget how many times we tried.
        await recordAttempt(db, runId, node.id, attempt)
        if (attempt < maxAttempts) await sleep(backoffMs(attempt))
      }
    }

    if (nodeError !== null) {
      // Exact blocker, owner-readable — pause (blocked) rather than hard-fail
      // for retryable classes; effect nodes surface Phase 53 states verbatim.
      await blockRun(db, run, `${node.label} ব্যর্থ (${node.id}): ${nodeError}`)
      return { status: 'blocked', completed: facts.completed, blocker: nodeError }
    }

    // Durable checkpoint: node output + completion in ONE optimistic commit.
    const current = await db.workflowRun.findUnique({ where: { id: runId } })
    if (!current) return { status: 'failed', completed: facts.completed, blocker: 'run vanished' }
    const cf = readFacts(current)
    if (!cf.completed.includes(node.id)) {
      const newFacts: TaskFacts = {
        ...cf,
        completed: [...cf.completed, node.id],
        outputs: { ...cf.outputs, [node.id]: output ?? null },
        attempts: { ...cf.attempts, [node.id]: attempt },
        blocker: null,
      }
      const committed = await db.$transaction(async (tx) => {
        const c = await tx.workflowRun.updateMany({
          where: { id: runId, stateVersion: current.stateVersion },
          data: { facts: newFacts, stateVersion: current.stateVersion + 1 },
        })
        if (c.count === 0) return false
        await tx.workflowRunEvent.create({
          data: {
            workflowRunId: runId,
            toStatus: 'active',
            fromState: 'running',
            toState: 'running',
            stateVersion: current.stateVersion + 1,
            cause: 'worker',
            detail: { node: node.id, label: node.label, kind: node.kind, attempt },
          },
        })
        return true
      })
      if (!committed) {
        // Someone else advanced the run — re-read and continue (their progress counts).
        const rr = await db.workflowRun.findUnique({ where: { id: runId } })
        if (rr) run = rr
        continue
      }
      run = { ...current, facts: newFacts, stateVersion: current.stateVersion + 1 }
    }

    // Test crash hook — simulates the process dying right after this commit.
    opts.afterNodeCheckpoint?.(node.id)
  }

  const final = await db.workflowRun.findUnique({ where: { id: runId } })
  if (!final) return { status: 'failed', completed: [], blocker: 'run vanished' }
  if (final.status === 'cancelled') return { status: 'cancelled', completed: readFacts(final).completed }
  await finishRun(db, final, 'done', null)
  return { status: 'done', completed: readFacts(final).completed }
}

async function transitionState(db: TaskDb, run: TaskRunRow, toState: string, detail: unknown): Promise<TaskRunRow | null> {
  return db.$transaction(async (tx) => {
    const c = await tx.workflowRun.updateMany({
      where: { id: run.id, stateVersion: run.stateVersion },
      data: { state: toState, stateVersion: run.stateVersion + 1 },
    })
    if (c.count === 0) return null
    await tx.workflowRunEvent.create({
      data: { workflowRunId: run.id, toStatus: run.status, fromState: run.state, toState, stateVersion: run.stateVersion + 1, cause: 'worker', detail },
    })
    return tx.workflowRun.findUnique({ where: { id: run.id } })
  })
}

async function blockRun(db: TaskDb, run: TaskRunRow, blocker: string): Promise<void> {
  const current = await db.workflowRun.findUnique({ where: { id: run.id } })
  if (!current || current.status !== 'active') return
  const facts = { ...readFacts(current), blocker }
  await db.$transaction(async (tx) => {
    const c = await tx.workflowRun.updateMany({
      where: { id: run.id, stateVersion: current.stateVersion },
      data: { state: 'blocked', facts, stateVersion: current.stateVersion + 1, leaseUntil: null },
    })
    if (c.count === 0) return
    await tx.workflowRunEvent.create({
      data: { workflowRunId: run.id, toStatus: 'active', fromState: current.state, toState: 'blocked', stateVersion: current.stateVersion + 1, cause: 'worker', detail: { blocker } },
    })
  })
}

async function finishRun(db: TaskDb, run: TaskRunRow, status: 'done' | 'failed', blocker: string | null): Promise<void> {
  const facts = { ...readFacts(run), blocker }
  await db.$transaction(async (tx) => {
    const c = await tx.workflowRun.updateMany({
      where: { id: run.id, status: 'active' },
      data: { status, state: 'finished', facts, stateVersion: run.stateVersion + 1, completedAt: new Date(), leaseUntil: null },
    })
    if (c.count === 0) return
    await tx.workflowRunEvent.create({
      data: { workflowRunId: run.id, fromStatus: 'active', toStatus: status, toState: 'finished', stateVersion: run.stateVersion + 1, cause: 'worker', detail: blocker ? { blocker } : {} },
    })
  })
}

async function recordAttempt(db: TaskDb, runId: string, nodeId: string, attempt: number): Promise<void> {
  const current = await db.workflowRun.findUnique({ where: { id: runId } })
  if (!current) return
  const facts = readFacts(current)
  facts.attempts = { ...facts.attempts, [nodeId]: attempt }
  await db.workflowRun.updateMany({
    where: { id: runId, stateVersion: current.stateVersion },
    data: { facts, stateVersion: current.stateVersion + 1 },
  })
}

// ── Owner-readable progress ──────────────────────────────────────────────────

export interface TaskProgress {
  runId: string
  goal: string
  status: string
  completed: Array<{ id: string; label: string }>
  current: { id: string; label: string } | null
  next: Array<{ id: string; label: string }>
  blocker: string | null
  etaSecRange: [number, number] | null
  costUsd: number
}

export async function getTaskProgress(runId: string, db: TaskDb = defaultTaskDb()): Promise<TaskProgress | null> {
  const run = await db.workflowRun.findUnique({ where: { id: runId } })
  if (!run) return null
  const inputs = (run.inputs ?? {}) as { graph?: string }
  const def = inputs.graph ? graphRegistry.get(inputs.graph) : undefined
  const facts = readFacts(run)
  const doneSet = new Set(facts.completed)
  const nodes = def?.nodes ?? []
  const remaining = nodes.filter((n) => !doneSet.has(n.id))
  const current = run.status === 'active' && remaining.length > 0 ? remaining[0] : null
  const rest = remaining.slice(current ? 1 : 0)
  const estRemaining = remaining.reduce((s, n) => s + (n.estimateSec ?? 30), 0)

  return {
    runId,
    goal: run.goal,
    status: run.status,
    completed: nodes.filter((n) => doneSet.has(n.id)).map((n) => ({ id: n.id, label: n.label })),
    current: current ? { id: current.id, label: current.label } : null,
    next: rest.map((n) => ({ id: n.id, label: n.label })),
    blocker: facts.blocker,
    etaSecRange: run.status === 'active' && remaining.length > 0 ? [Math.round(estRemaining * 0.5), Math.round(estRemaining * 2)] : null,
    costUsd: facts.costUsd,
  }
}

/**
 * Replay the persisted progress events exactly once from a client-supplied
 * cursor (event id order) — the reconnection contract for streams.
 */
export async function replayTaskEvents(
  runId: string,
  afterTs: Date | null,
  db: TaskDb = defaultTaskDb(),
): Promise<Array<{ id: string; toState: string; detail: unknown; ts: Date }>> {
  const events = await db.workflowRunEvent.findMany({
    where: { workflowRunId: runId, ...(afterTs ? { ts: { gt: afterTs } } : {}) },
    orderBy: { ts: 'asc' },
  })
  return events
}
