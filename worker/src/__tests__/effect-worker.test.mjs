/**
 * Phase 53 — effect-worker dispatcher tests.
 * Run: node --test worker/src/__tests__/effect-worker.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeBackoffMs,
  isLeaseFree,
  leaseDueOutboxRows,
  runEffectOutboxTick,
  DISPATCHABLE_STATES,
  TERMINAL_STATES,
} from '../effect-worker.mjs'

// ── Minimal supabase fake (chained query builder over in-memory tables) ──────

function makeFakeSb() {
  const tables = {
    agent_effect_outbox: [],
    agent_action_runs: [],
    agent_effect_ledger: [],
  }

  function from(name) {
    const rows = tables[name]
    function makeQuery(op, patch) {
      const filters = []
      const q = {
        _order: null,
        _limit: null,
        _selecting: false,
        eq(col, val) { filters.push((r) => r[col] === val); return q },
        is(col, val) { filters.push((r) => r[col] === val); return q },
        lte(col, val) { filters.push((r) => r[col] <= val); return q },
        order(col, { ascending }) { q._order = { col, ascending }; return q },
        limit(n) { q._limit = n; return q },
        select() { q._selecting = true; return q },
        then(resolve, reject) {
          try {
            let matched = rows.filter((r) => filters.every((f) => f(r)))
            if (q._order) {
              matched = [...matched].sort((a, b) => {
                const { col, ascending } = q._order
                return ascending ? (a[col] < b[col] ? -1 : 1) : (a[col] > b[col] ? -1 : 1)
              })
            }
            if (q._limit != null) matched = matched.slice(0, q._limit)
            if (op === 'select') return resolve({ data: matched.map((r) => ({ ...r })), error: null })
            if (op === 'update') {
              for (const r of matched) Object.assign(r, patch)
              return resolve({ data: q._selecting ? matched.map((r) => ({ ...r })) : null, error: null })
            }
            if (op === 'delete') {
              tables[name] = rows.filter((r) => !matched.includes(r))
              // keep reference for future from() calls
              tables[name].forEach(() => {})
              const removed = matched.length
              // swap array contents in place so closures over `rows` stay valid
              rows.length = 0
              rows.push(...tables[name])
              tables[name] = rows
              return resolve({ data: null, error: null, count: removed })
            }
            return resolve({ data: null, error: null })
          } catch (err) {
            return reject ? reject(err) : undefined
          }
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
          rows.push({ ...row })
          return resolve({ data: null, error: null })
        },
      }),
    }
  }

  return { from, tables }
}

const NOW = new Date('2026-07-17T06:00:00.000Z')

function seed(sb, { state = 'claimed', attempts = 0, maxAttempts = 5, dueAt = NOW, lease = null } = {}) {
  const runId = `run-${sb.tables.agent_action_runs.length + 1}`
  sb.tables.agent_action_runs.push({
    id: runId, state, state_version: 1, tool: 'send_whatsapp', error: null,
  })
  sb.tables.agent_effect_outbox.push({
    id: `ob-${runId}`, run_id: runId, due_at: dueAt.toISOString(), lease_until: lease, lease_owner: null,
    attempts, max_attempts: maxAttempts,
  })
  return runId
}

test('backoff is deterministic and capped at 5 minutes', () => {
  assert.equal(computeBackoffMs(1), 15_000)
  assert.equal(computeBackoffMs(2), 30_000)
  assert.equal(computeBackoffMs(5), 240_000)
  assert.equal(computeBackoffMs(6), 300_000)
  assert.equal(computeBackoffMs(99), 300_000)
})

test('lease is exclusive: an unexpired lease is skipped', async () => {
  const sb = makeFakeSb()
  seed(sb, { lease: new Date(NOW.getTime() + 30_000).toISOString() })
  const leased = await leaseDueOutboxRows(sb, { owner: 'w1', now: NOW })
  assert.equal(leased.length, 0)
})

test('expired lease can be re-leased', async () => {
  const sb = makeFakeSb()
  seed(sb, { lease: new Date(NOW.getTime() - 1000).toISOString() })
  const leased = await leaseDueOutboxRows(sb, { owner: 'w2', now: NOW })
  assert.equal(leased.length, 1)
  assert.equal(leased[0].lease_owner, 'w2')
})

test('isLeaseFree handles null and expired', () => {
  const nowIso = NOW.toISOString()
  assert.equal(isLeaseFree({ lease_until: null }, nowIso), true)
  assert.equal(isLeaseFree({ lease_until: '2026-07-17T05:00:00.000Z' }, nowIso), true)
  assert.equal(isLeaseFree({ lease_until: '2026-07-17T07:00:00.000Z' }, nowIso), false)
})

test('successful dispatch removes the outbox row exactly once', async () => {
  const sb = makeFakeSb()
  seed(sb)
  let dispatched = 0
  const summary = await runEffectOutboxTick({
    sb,
    dispatch: async () => { dispatched += 1; return { ok: true } },
    now: NOW,
  })
  assert.equal(summary.dispatched, 1)
  assert.equal(dispatched, 1)
  assert.equal(sb.tables.agent_effect_outbox.length, 0)

  // Second tick: nothing left to dispatch.
  const summary2 = await runEffectOutboxTick({ sb, dispatch: async () => { dispatched += 1; return { ok: true } }, now: NOW })
  assert.equal(summary2.leased, 0)
  assert.equal(dispatched, 1)
})

test('failed dispatch reschedules with backoff, then dead-letters with a ledger row', async () => {
  const sb = makeFakeSb()
  const runId = seed(sb, { attempts: 0, maxAttempts: 2 })

  // attempt 1 → reschedule
  const s1 = await runEffectOutboxTick({ sb, dispatch: async () => ({ ok: false, error: 'provider down' }), now: NOW })
  assert.equal(s1.rescheduled, 1)
  const row = sb.tables.agent_effect_outbox[0]
  assert.equal(row.attempts, 1)
  assert.ok(row.due_at > NOW.toISOString())

  // make it due again; attempt 2 (== max) → dead-letter
  row.due_at = NOW.toISOString()
  const s2 = await runEffectOutboxTick({ sb, dispatch: async () => ({ ok: false, error: 'provider still down' }), now: NOW })
  assert.equal(s2.deadLettered, 1)
  assert.equal(sb.tables.agent_effect_outbox.length, 0)
  const run = sb.tables.agent_action_runs.find((r) => r.id === runId)
  assert.equal(run.state, 'failed_final')
  const ledger = sb.tables.agent_effect_ledger.filter((l) => l.run_id === runId)
  assert.equal(ledger.length, 1)
  assert.equal(ledger[0].to_state, 'failed_final')
  assert.equal(ledger[0].payload.deadLetter, true)
})

test('terminal runs drop their outbox rows without dispatching', async () => {
  const sb = makeFakeSb()
  seed(sb, { state: 'succeeded' })
  let dispatched = 0
  const summary = await runEffectOutboxTick({ sb, dispatch: async () => { dispatched += 1; return { ok: true } }, now: NOW })
  assert.equal(summary.dropped, 1)
  assert.equal(dispatched, 0)
  assert.equal(sb.tables.agent_effect_outbox.length, 0)
})

test('non-dispatchable states (unknown_effect) are released to the reconciler, not dispatched', async () => {
  const sb = makeFakeSb()
  seed(sb, { state: 'unknown_effect' })
  let dispatched = 0
  const summary = await runEffectOutboxTick({ sb, dispatch: async () => { dispatched += 1; return { ok: true } }, now: NOW })
  assert.equal(summary.skipped, 1)
  assert.equal(dispatched, 0)
  assert.equal(sb.tables.agent_effect_outbox.length, 1) // still owned, rescheduled
  assert.equal(sb.tables.agent_effect_outbox[0].lease_until, null)
})

test('state sets are sane', () => {
  assert.ok(DISPATCHABLE_STATES.has('claimed'))
  assert.ok(DISPATCHABLE_STATES.has('failed_retryable'))
  assert.ok(TERMINAL_STATES.has('succeeded'))
  assert.ok(!DISPATCHABLE_STATES.has('executing'))
})
