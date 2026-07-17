/**
 * Phase 58 — chaos suite for the worker-side autonomy machinery.
 * Run: node --test worker/src/__tests__/autonomy-chaos.test.mjs
 *
 * Scenarios (roadmap): provider timeout, timeout-after-effect, DB loss,
 * worker kill (stale executing), duplicate delivery, clock skew, rate limit.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAutonomyReconcilerTick, STALE_EXECUTING_MS, UNKNOWN_ALERT_AFTER_MS } from '../autonomy-reconciler.mjs'
import { runWorkerEffect } from '../agent-task-runner.mjs'
import { runEffectOutboxTick } from '../effect-worker.mjs'

// ── Fake supabase (chained builder over in-memory tables; can inject faults) ──

function makeFakeSb() {
  const tables = {
    agent_action_runs: [],
    agent_effect_ledger: [],
    agent_effect_outbox: [],
  }
  let failNextSelect = false

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
        select() { return q },
        then(resolve) {
          if (op === 'select' && failNextSelect) {
            failNextSelect = false
            return resolve({ data: null, error: { message: 'db connection lost' } })
          }
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
          if (op === 'delete') {
            const keep = rows().filter((r) => !matched.includes(r))
            rows().length = 0
            rows().push(...keep)
            return resolve({ data: null, error: null })
          }
          return resolve({ data: null, error: null })
        },
      }
      return q
    }
    return {
      select: () => makeQuery('select'),
      update: (patch) => makeQuery('update', patch),
      delete: () => makeQuery('delete'),
      insert: (row) => ({
        then(resolve) {
          if (name === 'agent_action_runs' && rows().some((r) => r.idempotency_key === row.idempotency_key)) {
            return resolve({ data: null, error: { message: 'duplicate key' } })
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
  return { from, tables, injectDbLoss: () => { failNextSelect = true } }
}

const NOW = new Date('2026-07-17T12:00:00.000Z')

function seedEffect(sb, { state = 'executing', updatedAgoMs = STALE_EXECUTING_MS + 60_000, tool = 'send_whatsapp' } = {}) {
  const id = `run-${sb.tables.agent_action_runs.length + 1}`
  sb.tables.agent_action_runs.push({
    id,
    idempotency_key: `key-${id}`,
    tool,
    state,
    state_version: 1,
    attempts: 1,
    error: null,
    updated_at: new Date(NOW.getTime() - updatedAgoMs).toISOString(),
  })
  return id
}

test('chaos: worker kill mid-dispatch — stale executing becomes unknown_effect with ledger evidence', async () => {
  const sb = makeFakeSb()
  const runId = seedEffect(sb, { state: 'executing' })
  const summary = await runAutonomyReconcilerTick({ sb, now: NOW })
  assert.equal(summary.staleExecutingMarked, 1)
  const run = sb.tables.agent_action_runs.find((r) => r.id === runId)
  assert.equal(run.state, 'unknown_effect')
  assert.ok(sb.tables.agent_effect_ledger.some((l) => l.run_id === runId && l.to_state === 'unknown_effect'))
})

test('chaos: fresh executing runs are NOT touched (no premature unknown)', async () => {
  const sb = makeFakeSb()
  seedEffect(sb, { state: 'executing', updatedAgoMs: 30_000 })
  const summary = await runAutonomyReconcilerTick({ sb, now: NOW })
  assert.equal(summary.staleExecutingMarked, 0)
  assert.equal(sb.tables.agent_action_runs[0].state, 'executing')
})

test('chaos: long-stuck unknown alerts the owner exactly once', async () => {
  const sb = makeFakeSb()
  seedEffect(sb, { state: 'unknown_effect', updatedAgoMs: UNKNOWN_ALERT_AFTER_MS + 60_000 })
  const alerts = []
  const tick1 = await runAutonomyReconcilerTick({ sb, now: NOW, notify: async (m) => alerts.push(m) })
  assert.equal(tick1.unknownAlerts, 1)
  const tick2 = await runAutonomyReconcilerTick({ sb, now: NOW, notify: async (m) => alerts.push(m) })
  assert.equal(tick2.unknownAlerts, 0) // deduped via ledger note
  assert.equal(alerts.length, 1)
  assert.match(alerts[0], /অনিশ্চিত|যাচাই/)
})

test('chaos: DB loss during the sweep is reported, not thrown', async () => {
  const sb = makeFakeSb()
  sb.injectDbLoss()
  const summary = await runAutonomyReconcilerTick({ sb, now: NOW })
  assert.ok(summary.errors.length >= 1)
  assert.match(summary.errors[0], /db connection lost/)
})

test('chaos: expired dispatcher leases are released for takeover', async () => {
  const sb = makeFakeSb()
  sb.tables.agent_effect_outbox.push({
    id: 'ob-1',
    run_id: 'run-x',
    due_at: NOW.toISOString(),
    lease_until: new Date(NOW.getTime() - 1000).toISOString(),
    lease_owner: 'dead-worker',
    attempts: 1,
    max_attempts: 5,
  })
  const summary = await runAutonomyReconcilerTick({ sb, now: NOW })
  assert.equal(summary.leasesReleased, 1)
  assert.equal(sb.tables.agent_effect_outbox[0].lease_until, null)
})

test('chaos: clock skew — a lease in the future is NOT stolen', async () => {
  const sb = makeFakeSb()
  sb.tables.agent_effect_outbox.push({
    id: 'ob-2',
    run_id: 'run-y',
    due_at: NOW.toISOString(),
    lease_until: new Date(NOW.getTime() + 5 * 60_000).toISOString(), // future (skewed clock elsewhere)
    lease_owner: 'other-worker',
    attempts: 1,
    max_attempts: 5,
  })
  const summary = await runAutonomyReconcilerTick({ sb, now: NOW })
  assert.equal(summary.leasesReleased, 0)
  assert.equal(sb.tables.agent_effect_outbox[0].lease_owner, 'other-worker')
})

test('chaos: duplicate delivery — the same effect key executes once, replays after', async () => {
  const sb = makeFakeSb()
  let sends = 0
  const opts = {
    idempotencyKey: 'dup-key-1',
    tool: 'send_whatsapp',
    input: { to: 'x' },
    execute: async () => { sends += 1; return { success: true, providerRef: 'p1' } },
  }
  // Simulate BullMQ delivering the same job to two consumers back-to-back.
  const [a, b] = [await runWorkerEffect(sb, opts), await runWorkerEffect(sb, opts)]
  assert.equal(sends, 1)
  assert.ok(a.ok && b.ok)
  assert.ok(b.replayed)
})

test('chaos: provider timeout AFTER the effect (unknown) is never blind-retried by dispatch', async () => {
  const sb = makeFakeSb()
  let sends = 0
  const key = 'timeout-key-1'
  const first = await runWorkerEffect(sb, {
    idempotencyKey: key,
    tool: 'send_whatsapp',
    input: { to: 'z' },
    execute: async () => { sends += 1; throw new Error('ETIMEDOUT after provider accepted') },
  })
  assert.equal(first.state, 'unknown_effect')
  // Outbox row for the same run must be released to the reconciler, not dispatched.
  const runId = sb.tables.agent_action_runs[0].id
  sb.tables.agent_effect_outbox.push({ id: 'ob-t', run_id: runId, due_at: NOW.toISOString(), lease_until: null, lease_owner: null, attempts: 0, max_attempts: 5 })
  let dispatched = 0
  const tick = await runEffectOutboxTick({ sb, dispatch: async () => { dispatched += 1; return { ok: true } }, now: NOW })
  assert.equal(tick.skipped, 1)
  assert.equal(dispatched, 0)
  assert.equal(sends, 1)
})

test('chaos: provider rate limit — retryable failure backs off through the outbox, no tight loop', async () => {
  const sb = makeFakeSb()
  const runId = seedEffect(sb, { state: 'claimed', updatedAgoMs: 0 })
  sb.tables.agent_effect_outbox.push({ id: 'ob-r', run_id: runId, due_at: NOW.toISOString(), lease_until: null, lease_owner: null, attempts: 0, max_attempts: 5 })
  const tick = await runEffectOutboxTick({ sb, dispatch: async () => ({ ok: false, error: '429 rate limited' }), now: NOW })
  assert.equal(tick.rescheduled, 1)
  const row = sb.tables.agent_effect_outbox[0]
  assert.ok(row.due_at > NOW.toISOString()) // backoff pushed it into the future
})
