/**
 * Phase 54 — worker durable-task runner tests.
 * Run: node --test worker/src/__tests__/agent-task-runner.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  acquireWorkerLease,
  backoffMs,
  clearWorkerTaskGraphs,
  registerWorkerTaskGraph,
  runDurableTaskOnWorker,
  runWorkerEffect,
} from '../agent-task-runner.mjs'

// ── Fake supabase over in-memory tables (chained builder) ─────────────────────

function makeFakeSb() {
  const tables = {
    workflow_runs: [],
    workflow_run_events: [],
    agent_action_runs: [],
    agent_effect_ledger: [],
  }

  function from(name) {
    const rows = () => tables[name]
    function makeQuery(op, patch) {
      const filters = []
      const q = {
        _order: null,
        _limit: null,
        eq(col, val) { filters.push((r) => r[col] === val); return q },
        is(col, val) { filters.push((r) => r[col] === val); return q },
        lte(col, val) { filters.push((r) => r[col] <= val); return q },
        order(col, { ascending }) { q._order = { col, ascending }; return q },
        limit(n) { q._limit = n; return q },
        select() { q._selecting = true; return op === 'select' ? q : q },
        then(resolve) {
          let matched = rows().filter((r) => filters.every((f) => f(r)))
          if (q._order) {
            const { col, ascending } = q._order
            matched = [...matched].sort((a, b) => (ascending ? (a[col] < b[col] ? -1 : 1) : (a[col] > b[col] ? -1 : 1)))
          }
          if (q._limit != null) matched = matched.slice(0, q._limit)
          if (op === 'select') return resolve({ data: matched.map((r) => ({ ...r })), error: null })
          if (op === 'update') {
            for (const r of matched) Object.assign(r, patch)
            return resolve({ data: matched.map((r) => ({ ...r })), error: null })
          }
          return resolve({ data: null, error: null })
        },
      }
      return q
    }
    return {
      select: () => makeQuery('select'),
      update: (patch) => makeQuery('update', patch),
      insert: (row) => ({
        then(resolve) {
          if (name === 'agent_action_runs' && rows().some((r) => r.idempotency_key === row.idempotency_key)) {
            return resolve({ data: null, error: { message: 'duplicate key value violates unique constraint' } })
          }
          if (name === 'agent_effect_ledger' && rows().some((r) => r.run_id === row.run_id && r.seq === row.seq)) {
            return resolve({ data: null, error: { message: 'duplicate key' } })
          }
          rows().push({ ...row })
          return resolve({ data: null, error: null })
        },
      }),
    }
  }
  return { from, tables }
}

function seedRun(sb, { graph = 'demo', status = 'active', state = 'queued', facts = null, lease = null } = {}) {
  const id = `wr-${sb.tables.workflow_runs.length + 1}`
  sb.tables.workflow_runs.push({
    id,
    conversation_id: null,
    business_id: 'ALMA_LIFESTYLE',
    kind: 'durable_task',
    goal: 'test goal',
    status,
    state,
    state_version: 1,
    inputs: { graph, args: {} },
    facts: facts ?? { completed: [], outputs: {}, attempts: {}, blocker: null, costUsd: 0 },
    lease_until: lease,
    completed_at: null,
  })
  return id
}

let executions
beforeEach(() => {
  clearWorkerTaskGraphs()
  executions = {}
})

function count(id) {
  executions[id] = (executions[id] ?? 0) + 1
}

function registerDemo({ failNode, failTimes = Infinity } = {}) {
  let failsLeft = failTimes
  registerWorkerTaskGraph({
    name: 'demo',
    goal: 'demo',
    nodes: [
      { id: 'n1', kind: 'read', label: 'read', run: async () => { count('n1'); return { ok: 1 } } },
      {
        id: 'n2', kind: 'plan', label: 'plan',
        run: async () => {
          count('n2')
          if (failNode === 'n2' && failsLeft > 0) { failsLeft -= 1; throw new Error('redis connection lost') }
          return { ok: 2 }
        },
      },
      { id: 'n3', kind: 'verify', label: 'verify', run: async (ctx) => { count('n3'); return { sawN1: Boolean(ctx.outputs.n1) } } },
    ],
  })
}

test('backoff deterministic', () => {
  assert.equal(backoffMs(1), 5_000)
  assert.equal(backoffMs(2), 10_000)
  assert.equal(backoffMs(10), 60_000)
})

test('happy path: all nodes run once, checkpoints + done', async () => {
  const sb = makeFakeSb()
  registerDemo()
  const runId = seedRun(sb)
  const result = await runDurableTaskOnWorker({ sb, runId, sleep: async () => {} })
  assert.equal(result.status, 'done')
  assert.deepEqual(result.completed, ['n1', 'n2', 'n3'])
  assert.deepEqual(executions, { n1: 1, n2: 1, n3: 1 })
  const run = sb.tables.workflow_runs[0]
  assert.equal(run.status, 'done')
  assert.ok(sb.tables.workflow_run_events.length >= 4)
})

test('kill after each node boundary → resume completes without re-running nodes', async () => {
  for (const killNode of ['n1', 'n2', 'n3']) {
    clearWorkerTaskGraphs()
    executions = {}
    registerDemo()
    const sb = makeFakeSb()
    const runId = seedRun(sb)

    await assert.rejects(
      runDurableTaskOnWorker({
        sb, runId, sleep: async () => {},
        afterNodeCheckpoint: (n) => { if (n === killNode) throw new Error('SIGKILL') },
      }),
      /SIGKILL/,
    )

    const later = () => new Date(Date.now() + 10 * 60_000)
    const result = await runDurableTaskOnWorker({ sb, runId, sleep: async () => {}, now: later })
    assert.equal(result.status, 'done', `kill at ${killNode}`)
    assert.equal(executions.n1, 1)
    assert.equal(executions.n2, 1)
    assert.equal(executions.n3, 1)
  }
})

test('duplicate workers cannot hold the same lease', async () => {
  const sb = makeFakeSb()
  registerDemo()
  const runId = seedRun(sb)
  const now = new Date()
  const first = await acquireWorkerLease(sb, runId, { owner: 'w1', now })
  assert.ok(first)
  const second = await acquireWorkerLease(sb, runId, { owner: 'w2', now })
  assert.equal(second, null)
  const afterExpiry = await acquireWorkerLease(sb, runId, { owner: 'w2', now: new Date(now.getTime() + 10 * 60_000) })
  assert.ok(afterExpiry)
})

test('persistent failure blocks with the exact blocker; retry resumes from the failed node', async () => {
  const sb = makeFakeSb()
  registerDemo({ failNode: 'n2' })
  const runId = seedRun(sb)
  const result = await runDurableTaskOnWorker({ sb, runId, sleep: async () => {} })
  assert.equal(result.status, 'blocked')
  assert.match(result.blocker, /redis connection lost/)
  const run = sb.tables.workflow_runs[0]
  assert.equal(run.state, 'blocked')
  assert.match(run.facts.blocker, /redis connection lost/)
  assert.deepEqual(run.facts.completed, ['n1'])

  // Recovery: re-register a healthy graph and retry — n1 must not re-run.
  clearWorkerTaskGraphs()
  registerDemo({ failNode: null })
  const later = () => new Date(Date.now() + 10 * 60_000)
  const retry = await runDurableTaskOnWorker({ sb, runId, sleep: async () => {}, now: later })
  assert.equal(retry.status, 'done')
  assert.equal(executions.n1, 1)
})

test('cancellation honoured at node boundaries', async () => {
  const sb = makeFakeSb()
  registerWorkerTaskGraph({
    name: 'demo',
    goal: 'x',
    nodes: [
      { id: 'n1', kind: 'read', label: 'a', run: async () => { count('n1'); return 1 } },
      {
        id: 'n2', kind: 'read', label: 'b',
        run: async () => {
          count('n2')
          const run = sb.tables.workflow_runs[0]
          run.status = 'cancelled'
          return 2
        },
      },
      { id: 'n3', kind: 'read', label: 'c', run: async () => { count('n3'); return 3 } },
    ],
  })
  const runId = seedRun(sb)
  const result = await runDurableTaskOnWorker({ sb, runId, sleep: async () => {} })
  assert.equal(result.status, 'cancelled')
  assert.equal(executions.n3, undefined)
})

test('worker effect helper is exactly-once: replay returns the stored outcome', async () => {
  const sb = makeFakeSb()
  let sends = 0
  const opts = {
    idempotencyKey: 'task:wr-1:send:send_whatsapp',
    tool: 'send_whatsapp',
    input: { to: 'x' },
    execute: async () => { sends += 1; return { success: true, providerRef: 'wa-9', data: { sent: true } } },
  }
  const first = await runWorkerEffect(sb, opts)
  assert.equal(first.ok, true)
  assert.equal(sends, 1)
  const second = await runWorkerEffect(sb, opts)
  assert.equal(second.ok, true)
  assert.equal(second.replayed, true)
  assert.equal(sends, 1)
  // Ledger chain exists with a proof row.
  const ledger = sb.tables.agent_effect_ledger
  assert.ok(ledger.some((l) => l.kind === 'proof'))
})

test('worker effect helper: crash mid-dispatch goes unknown and is never blind-retried', async () => {
  const sb = makeFakeSb()
  let sends = 0
  const opts = {
    idempotencyKey: 'task:wr-2:send:send_whatsapp',
    tool: 'send_whatsapp',
    input: { to: 'y' },
    execute: async () => { sends += 1; throw new Error('socket hang up') },
  }
  const first = await runWorkerEffect(sb, opts)
  assert.equal(first.ok, false)
  assert.equal(first.state, 'unknown_effect')
  assert.equal(sends, 1)
  const second = await runWorkerEffect(sb, { ...opts, execute: async () => { sends += 1; return { success: true } } })
  assert.equal(second.ok, false)
  assert.equal(second.state, 'unknown_effect')
  assert.equal(sends, 1) // reconciler owns it — no worker retry
})
