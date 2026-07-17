/**
 * Phase 54 — VPS durable-task runner (mirror of src/agent/lib/graph/
 * durable-task-graph.ts semantics, over supabase snake_case tables).
 *
 * Consumes 'durable-task' jobs from the long-agent-task queue: leases the
 * workflow_runs row (CAS — duplicate workers cannot hold the same run),
 * executes the graph's nodes in order, and CHECKPOINTS after every node so a
 * killed worker resumes from the next safe point. Effect nodes run through a
 * compact exactly-once effect helper on agent_action_runs (same idempotency
 * semantics as the Phase 53 TS engine): a crash mid-effect resumes as
 * replay-stored-outcome or unknown-effect, never a second dispatch.
 *
 * Graph definitions are code-registered (registerWorkerTaskGraph) — the DB row
 * carries only { graph, args }.
 */

const graphs = new Map()

/** @param {{name: string, goal: string, nodes: Array<{id: string, kind: 'read'|'plan'|'verify'|'effect', label: string, run: Function, maxAttempts?: number}>}} def */
export function registerWorkerTaskGraph(def) {
  if (!def?.name || !Array.isArray(def.nodes) || def.nodes.length === 0) throw new Error('bad graph def')
  graphs.set(def.name, def)
}

export function getWorkerTaskGraph(name) {
  return graphs.get(name)
}

export function clearWorkerTaskGraphs() {
  graphs.clear()
}

export function backoffMs(attempt) {
  return Math.min(60_000, 5_000 * 2 ** Math.max(0, attempt - 1))
}

function readFacts(run) {
  const f = run.facts ?? {}
  return {
    completed: Array.isArray(f.completed) ? f.completed : [],
    outputs: f.outputs ?? {},
    attempts: f.attempts ?? {},
    blocker: typeof f.blocker === 'string' ? f.blocker : null,
    costUsd: typeof f.costUsd === 'number' ? f.costUsd : 0,
  }
}

async function getRun(sb, runId) {
  const { data, error } = await sb.from('workflow_runs').select('*').eq('id', runId).limit(1)
  if (error) throw new Error(`workflow_runs read failed: ${error.message}`)
  return (data ?? [])[0] ?? null
}

/** CAS lease — returns the run or null when another worker holds it. */
export async function acquireWorkerLease(sb, runId, { owner, leaseMs = 120_000, now = new Date() } = {}) {
  const run = await getRun(sb, runId)
  if (!run || run.status !== 'active') return null
  const nowIso = now.toISOString()
  if (run.lease_until && run.lease_until > nowIso) return null
  const leaseUntil = new Date(now.getTime() + leaseMs).toISOString()
  let claim = sb.from('workflow_runs').update({ lease_until: leaseUntil }).eq('id', runId).eq('status', 'active')
  claim = run.lease_until === null ? claim.is('lease_until', null) : claim.eq('lease_until', run.lease_until)
  const { data: updated, error } = await claim.select()
  if (error || (updated ?? []).length !== 1) return null
  return { ...run, lease_until: leaseUntil, lease_owner: owner }
}

async function appendEvent(sb, runId, stateVersion, patch) {
  const { error } = await sb.from('workflow_run_events').insert({
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${runId}-${stateVersion}-${Math.random().toString(36).slice(2, 8)}`,
    workflow_run_id: runId,
    from_status: patch.fromStatus ?? null,
    to_status: patch.toStatus ?? 'active',
    from_state: patch.fromState ?? null,
    to_state: patch.toState ?? 'running',
    state_version: stateVersion,
    cause: 'worker',
    detail: patch.detail ?? {},
  })
  if (error) throw new Error(`workflow_run_events insert failed: ${error.message}`)
}

/** Optimistic facts/state update; returns false when the CAS lost. */
async function casUpdate(sb, run, data, eventPatch) {
  const { data: updated, error } = await sb
    .from('workflow_runs')
    .update({ ...data, state_version: run.state_version + 1 })
    .eq('id', run.id)
    .eq('state_version', run.state_version)
    .select()
  if (error) throw new Error(`workflow_runs update failed: ${error.message}`)
  if ((updated ?? []).length !== 1) return false
  await appendEvent(sb, run.id, run.state_version + 1, eventPatch)
  return true
}

// ── Compact exactly-once effect helper (agent_action_runs) ───────────────────

/**
 * @param {object} sb supabase-like client
 * @param {{ idempotencyKey: string, tool: string, input: object, riskTier?: string,
 *           conversationId?: string|null, businessId?: string|null,
 *           execute: Function }} opts
 */
export async function runWorkerEffect(sb, opts) {
  const { data: existingRows } = await sb.from('agent_action_runs').select('*').eq('idempotency_key', opts.idempotencyKey).limit(1)
  let run = (existingRows ?? [])[0] ?? null

  if (run) {
    if (run.state === 'succeeded') return { ok: true, replayed: true, runId: run.id, result: run.result ?? undefined }
    if (['denied', 'expired', 'failed_final', 'compensated'].includes(run.state)) {
      return { ok: false, replayed: true, runId: run.id, error: run.error ?? `effect in state ${run.state}`, state: run.state }
    }
    if (['executing', 'unknown_effect', 'verifying'].includes(run.state)) {
      // Dispatch may have happened — NEVER blind-retry from the worker.
      if (run.state === 'executing') {
        await sb.from('agent_action_runs').update({ state: 'unknown_effect', state_version: run.state_version + 1 }).eq('id', run.id).eq('state', 'executing')
      }
      return { ok: false, replayed: true, runId: run.id, error: 'effect outcome unknown — reconciler owns it', state: 'unknown_effect' }
    }
    // claimed / failed_retryable → safe to (re)execute below.
  } else {
    const id = globalThis.crypto?.randomUUID ? crypto.randomUUID() : `eff-${Math.random().toString(36).slice(2, 12)}`
    const { error: insertErr } = await sb.from('agent_action_runs').insert({
      id,
      idempotency_key: opts.idempotencyKey,
      effect_hash: opts.idempotencyKey,
      tool: opts.tool,
      surface: 'worker',
      actor: 'agent',
      instruction_origin: 'owner_policy',
      conversation_id: opts.conversationId ?? null,
      business_id: opts.businessId ?? null,
      risk_tier: opts.riskTier ?? 'R2',
      policy_version: 'p52.1',
      state: 'claimed',
      state_version: 1,
      attempts: 0,
      input: opts.input ?? {},
    })
    if (insertErr) {
      // Unique-key race: someone else claimed it — recurse once to replay.
      return runWorkerEffect(sb, opts)
    }
    const { data: created } = await sb.from('agent_action_runs').select('*').eq('idempotency_key', opts.idempotencyKey).limit(1)
    run = (created ?? [])[0]
    await insertLedger(sb, run.id, 1, 'transition', null, 'claimed', { worker: true })
  }

  // claimed → executing COMMITS BEFORE dispatch.
  const { data: markExec } = await sb
    .from('agent_action_runs')
    .update({ state: 'executing', state_version: run.state_version + 1, attempts: (run.attempts ?? 0) + 1 })
    .eq('id', run.id)
    .eq('state', run.state)
    .select()
  if ((markExec ?? []).length !== 1) {
    return { ok: false, replayed: true, runId: run.id, error: 'lost effect claim race', state: 'claimed' }
  }
  await insertLedger(sb, run.id, null, 'transition', run.state, 'executing', { attempt: (run.attempts ?? 0) + 1 })

  let result
  try {
    result = await opts.execute({ idempotencyKey: opts.idempotencyKey, attempt: (run.attempts ?? 0) + 1 })
  } catch (err) {
    await sb.from('agent_action_runs').update({ state: 'unknown_effect', state_version: run.state_version + 2, error: String(err?.message ?? err) }).eq('id', run.id).eq('state', 'executing')
    await insertLedger(sb, run.id, null, 'transition', 'executing', 'unknown_effect', { thrown: true })
    return { ok: false, replayed: false, runId: run.id, error: 'effect outcome unknown', state: 'unknown_effect' }
  }

  if (result?.success) {
    const proof = result.providerRef ? { kind: 'provider_receipt', providerRef: result.providerRef } : { kind: 'result_envelope', success: true }
    await sb
      .from('agent_action_runs')
      .update({ state: 'succeeded', state_version: run.state_version + 2, result: result.data ?? null, provider_ref: result.providerRef ?? null, proof, error: null })
      .eq('id', run.id)
      .eq('state', 'executing')
    await insertLedger(sb, run.id, null, 'proof', null, null, proof)
    await insertLedger(sb, run.id, null, 'transition', 'executing', 'succeeded', {})
    return { ok: true, replayed: false, runId: run.id, result: result.data }
  }

  const toState = result?.retryable ? 'failed_retryable' : 'failed_final'
  await sb.from('agent_action_runs').update({ state: toState, state_version: run.state_version + 2, error: result?.error ?? 'effect failed' }).eq('id', run.id).eq('state', 'executing')
  await insertLedger(sb, run.id, null, 'transition', 'executing', toState, { errorCode: result?.errorCode ?? null })
  return { ok: false, replayed: false, runId: run.id, error: result?.error ?? 'effect failed', state: toState }
}

async function insertLedger(sb, runId, seq, kind, fromState, toState, payload) {
  let nextSeq = seq
  if (nextSeq == null) {
    const { data: last } = await sb.from('agent_effect_ledger').select('seq').eq('run_id', runId).order('seq', { ascending: false }).limit(1)
    nextSeq = ((last ?? [])[0]?.seq ?? 0) + 1
  }
  const { error } = await sb.from('agent_effect_ledger').insert({
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : `${runId}-l${nextSeq}`,
    run_id: runId,
    seq: nextSeq,
    kind,
    from_state: fromState,
    to_state: toState,
    payload: payload ?? null,
  })
  if (error) throw new Error(`ledger insert failed: ${error.message}`)
}

// ── The runner ────────────────────────────────────────────────────────────────

/**
 * Execute (or resume) one durable task on the worker.
 * @param {{ sb: object, runId: string, owner?: string, leaseMs?: number,
 *           now?: () => Date, sleep?: (ms:number)=>Promise<void>,
 *           afterNodeCheckpoint?: (nodeId:string)=>void }} opts
 */
export async function runDurableTaskOnWorker(opts) {
  const { sb, runId } = opts
  const owner = opts.owner ?? 'vps-worker'
  const now = opts.now ?? (() => new Date())
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))

  const leased = await acquireWorkerLease(sb, runId, { owner, leaseMs: opts.leaseMs, now: now() })
  if (!leased) {
    const run = await getRun(sb, runId)
    if (run && run.status !== 'active') {
      return { status: run.status === 'done' ? 'done' : run.status, completed: readFacts(run).completed }
    }
    return { status: 'lease_unavailable', completed: [] }
  }

  const def = graphs.get(leased.inputs?.graph)
  if (!def) {
    await casUpdate(sb, leased, { status: 'failed', state: 'finished', completed_at: now().toISOString(), lease_until: null }, {
      fromStatus: 'active', toStatus: 'failed', toState: 'finished', detail: { blocker: `unknown graph ${leased.inputs?.graph ?? '(none)'}` },
    })
    return { status: 'failed', completed: [], blocker: 'unknown graph' }
  }

  let run = leased
  const args = leased.inputs?.args ?? {}

  for (const node of def.nodes) {
    let facts = readFacts(run)
    if (facts.completed.includes(node.id)) continue

    // Cancellation at every node boundary.
    const fresh = await getRun(sb, runId)
    if (!fresh || fresh.status === 'cancelled') return { status: 'cancelled', completed: facts.completed }
    run = fresh
    facts = readFacts(run)

    // Heartbeat.
    await sb.from('workflow_runs').update({ lease_until: new Date(now().getTime() + (opts.leaseMs ?? 120_000)).toISOString() }).eq('id', runId)

    const ctx = {
      runId,
      args,
      outputs: facts.outputs,
      isCancelled: async () => {
        const r = await getRun(sb, runId)
        return !r || r.status === 'cancelled'
      },
      effect: (effectOpts) =>
        runWorkerEffect(sb, {
          idempotencyKey: `task:${runId}:${node.id}:${effectOpts.tool}`,
          tool: effectOpts.tool,
          input: effectOpts.input ?? {},
          riskTier: effectOpts.riskTier,
          conversationId: run.conversation_id,
          businessId: run.business_id,
          execute: effectOpts.execute,
        }),
    }

    const maxAttempts = node.kind === 'effect' ? 1 : (node.maxAttempts ?? 3)
    // Fresh attempt budget per invocation — a blocked run retried later must
    // actually retry (facts.attempts is observability only).
    let attempt = 0
    let output
    let nodeError = null

    while (attempt < maxAttempts) {
      attempt += 1
      try {
        output = await node.run(ctx)
        nodeError = null
        break
      } catch (err) {
        nodeError = String(err?.message ?? err)
        const cur = await getRun(sb, runId)
        if (cur) {
          const f = readFacts(cur)
          f.attempts = { ...f.attempts, [node.id]: attempt }
          await sb.from('workflow_runs').update({ facts: f, state_version: cur.state_version + 1 }).eq('id', runId).eq('state_version', cur.state_version)
        }
        if (attempt < maxAttempts) await sleep(backoffMs(attempt))
      }
    }

    if (nodeError !== null) {
      const cur = await getRun(sb, runId)
      if (cur && cur.status === 'active') {
        const f = { ...readFacts(cur), blocker: `${node.label} (${node.id}): ${nodeError}` }
        await casUpdate(sb, cur, { state: 'blocked', facts: f, lease_until: null }, {
          fromState: cur.state, toState: 'blocked', detail: { blocker: f.blocker },
        })
      }
      return { status: 'blocked', completed: facts.completed, blocker: nodeError }
    }

    // Durable checkpoint.
    const current = await getRun(sb, runId)
    if (!current) return { status: 'failed', completed: facts.completed, blocker: 'run vanished' }
    const cf = readFacts(current)
    if (!cf.completed.includes(node.id)) {
      const newFacts = {
        ...cf,
        completed: [...cf.completed, node.id],
        outputs: { ...cf.outputs, [node.id]: output ?? null },
        attempts: { ...cf.attempts, [node.id]: attempt },
        blocker: null,
      }
      const committed = await casUpdate(sb, current, { facts: newFacts, state: 'running' }, {
        fromState: current.state, toState: 'running', detail: { node: node.id, label: node.label, kind: node.kind, attempt },
      })
      if (!committed) {
        const rr = await getRun(sb, runId)
        if (rr) run = rr
        continue
      }
      run = { ...current, facts: newFacts, state: 'running', state_version: current.state_version + 1 }
    }

    if (opts.afterNodeCheckpoint) opts.afterNodeCheckpoint(node.id)
  }

  const final = await getRun(sb, runId)
  if (!final) return { status: 'failed', completed: [], blocker: 'run vanished' }
  if (final.status === 'cancelled') return { status: 'cancelled', completed: readFacts(final).completed }
  if (final.status === 'active') {
    await casUpdate(sb, final, { status: 'done', state: 'finished', completed_at: now().toISOString(), lease_until: null }, {
      fromStatus: 'active', toStatus: 'done', toState: 'finished', detail: {},
    })
  }
  return { status: 'done', completed: readFacts(final).completed }
}
