/**
 * Phase 35 — durable agent-graph-run contract: checkpoint/resume without
 * duplicated work, heartbeat, cancellation, deadline, failure isolation.
 * Run with: node --test worker/src/__tests__/agent-graph-run.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  createAgentGraphRunner,
  runSourceBoundSpecialistBrief,
} from '../agent-graph-run.mjs'

function makeDeps(overrides = {}) {
  const state = { progress: null, heartbeats: 0, ran: [] }
  const deps = {
    runBrief: async (brief) => {
      state.ran.push(brief.id)
      return { success: true, summary: `ok:${brief.id}` }
    },
    saveProgress: async (p) => { state.progress = JSON.parse(JSON.stringify(p)) },
    loadProgress: async () => state.progress,
    heartbeat: async () => { state.heartbeats++ },
    isCancelled: async () => false,
    ...overrides,
  }
  return { deps, state }
}

const briefs = (n) => Array.from({ length: n }, (_, i) => ({ id: i, role: 'researcher', task: `t${i}` }))

test('worker wiring has no free-form specialist internalControl authority', () => {
  const workerSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
  assert.match(workerSource, /runSourceBoundSpecialistBrief/)
  assert.doesNotMatch(workerSource, /message:\s*`\[INTERNAL SPECIALIST BRIEF/)
  assert.match(workerSource, /attempts:\s*8,\s*backoff:\s*\{ type: 'exponential', delay: 5000 \}/)
})

test('runs every brief, checkpoints after each, reports done', async () => {
  const { deps, state } = makeDeps()
  const run = createAgentGraphRunner(deps)
  const out = await run({ briefs: briefs(3) })
  assert.equal(out.status, 'done')
  assert.equal(out.findings.length, 3)
  assert.equal(out.remaining, 0)
  assert.equal(state.heartbeats, 3)
  assert.deepEqual(state.progress.completed, [0, 1, 2])
  assert.equal(state.progress.status, 'done')
})

test('passes the exact persisted brief index to the source-bound dispatcher', async () => {
  const seen = []
  const { deps } = makeDeps({
    runBrief: async (brief, index) => {
      seen.push({ id: brief.id, index })
      return { success: true, summary: `ok:${brief.id}` }
    },
  })

  await createAgentGraphRunner(deps)({ briefs: briefs(3) })

  assert.deepEqual(seen, [
    { id: 0, index: 0 },
    { id: 1, index: 1 },
    { id: 2, index: 2 },
  ])
})

test('crash/retry resumes WITHOUT duplicating completed work', async () => {
  const { deps, state } = makeDeps({
    runBrief: async (brief) => {
      state.ran.push(brief.id)
      if (brief.id === 1 && state.ran.filter((x) => x === 1).length === 1) {
        // Simulate a process crash mid-brief: progress for briefs 0 is saved,
        // brief 1 dies hard (throw escapes ONLY in this simulated harness).
        throw Object.assign(new Error('worker_crash'), { crash: true })
      }
      return { success: true, summary: `ok:${brief.id}` }
    },
  })
  const run = createAgentGraphRunner(deps)
  // First attempt — brief 1 "fails" (recorded as failed finding, not a crash
  // of the runner: the runner isolates throw per brief).
  const first = await run({ briefs: briefs(3) })
  assert.equal(first.status, 'done')
  const failed = first.findings.find((f) => f.index === 1)
  assert.equal(failed.success, false)
  assert.equal(failed.error, 'worker_crash')

  // BullMQ retry of the same job: completed set skips 0..2 — ZERO re-runs.
  const ranBefore = state.ran.length
  const second = await run({ briefs: briefs(3) })
  assert.equal(second.status, 'done')
  assert.equal(second.resumedFrom, 3)
  assert.equal(state.ran.length, ranBefore, 'no brief re-ran on retry')
})

test('mid-run kill (saveProgress dies) resumes from the checkpoint on retry', async () => {
  let killAfter = 1 // let brief 0 checkpoint, then die
  const { deps, state } = makeDeps()
  const killer = {
    ...deps,
    saveProgress: async (p) => {
      if (killAfter-- <= 0) throw new Error('SIGKILL')
      await deps.saveProgress(p)
    },
  }
  const run = createAgentGraphRunner(killer)
  await assert.rejects(() => run({ briefs: briefs(3) }), /SIGKILL/)
  assert.deepEqual(state.progress.completed, [0], 'brief 0 checkpointed before the kill')

  // Retry with healthy persistence: resumes at brief 1, never re-runs 0.
  const healthy = createAgentGraphRunner({ ...deps, saveProgress: async (p) => { state.progress = p } })
  state.ran.length = 0
  const out = await healthy({ briefs: briefs(3) })
  assert.equal(out.status, 'done')
  assert.equal(out.resumedFrom, 1)
  assert.deepEqual(state.ran, [1, 2], 'only the unfinished briefs ran')
})

test('cancellation between briefs checkpoints and stops', async () => {
  let calls = 0
  const { deps, state } = makeDeps({ isCancelled: async () => ++calls > 1 })
  const run = createAgentGraphRunner(deps)
  const out = await run({ briefs: briefs(3) })
  assert.equal(out.status, 'cancelled')
  assert.equal(state.progress.status, 'cancelled')
  assert.ok(out.remaining >= 1)
})

test('deadline checkpoints the tail and reports partial', async () => {
  let t = 0
  const { deps } = makeDeps()
  const run = createAgentGraphRunner({ ...deps, deadlineMs: 100, now: () => (t += 80) })
  const out = await run({ briefs: briefs(5) })
  assert.equal(out.status, 'partial')
  assert.ok(out.remaining > 0)
})

test('a failed brief is visible and does not erase sibling findings', async () => {
  const { deps } = makeDeps({
    runBrief: async (b) => (b.id === 1 ? { success: false, summary: '', error: 'provider_500' } : { success: true, summary: `ok:${b.id}` }),
  })
  const run = createAgentGraphRunner(deps)
  const out = await run({ briefs: briefs(3) })
  assert.equal(out.status, 'done')
  assert.equal(out.findings.filter((f) => f.success).length, 2)
  const failed = out.findings.find((f) => f.index === 1)
  assert.equal(failed.success, false)
  assert.equal(failed.error, 'provider_500')
})

test('specialist transport sends only persisted source identity, never brief prose', async () => {
  let posted
  const result = await runSourceBoundSpecialistBrief({
    pendingActionId: 'action-1',
    briefIndex: 2,
    appUrl: 'https://app.invalid',
    token: 'test-token',
    fetchImpl: async (_url, init) => {
      posted = JSON.parse(init.body)
      return new Response(JSON.stringify({ reply: 'persisted specialist result' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })

  assert.deepEqual(posted, {
    internalControl: true,
    continuationSource: {
      kind: 'specialist_brief', pendingActionId: 'action-1', briefIndex: 2,
    },
  })
  assert.equal('message' in posted, false)
  assert.equal('conversationId' in posted, false)
  assert.deepEqual(result, { success: true, summary: 'persisted specialist result' })
})

test('duplicate terminal observe reuses the exact linked assistant text', async () => {
  const result = await runSourceBoundSpecialistBrief({
    pendingActionId: 'action-1', briefIndex: 1,
    appUrl: 'https://app.invalid', token: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({
      observe: true, status: 'done', assistantMessageId: 'message-1', text: 'durable exact result',
    }), {
      status: 202,
      headers: { 'content-type': 'application/json', 'x-agent-continuation-observe': '1' },
    }),
  })

  assert.deepEqual(result, { success: true, summary: 'durable exact result' })
})

test('running or empty terminal observe remains retryable and is not checkpointed complete', async () => {
  const fetchImpl = async () => new Response(JSON.stringify({
    observe: true, status: 'running', assistantMessageId: null, text: '',
  }), {
    status: 202,
    headers: { 'content-type': 'application/json', 'x-agent-continuation-observe': '1' },
  })
  const { deps, state } = makeDeps({
    runBrief: async (_brief, index) => runSourceBoundSpecialistBrief({
      pendingActionId: 'action-1', briefIndex: index,
      appUrl: 'https://app.invalid', token: 'test-token', fetchImpl,
    }),
  })

  await assert.rejects(
    () => createAgentGraphRunner(deps)({ briefs: briefs(1) }),
    (error) => error?.retryable === true && error?.message === 'specialist_continuation_running',
  )
  assert.equal(state.progress, null)
})

test('non-retryable specialist admission failure stays visible as a failed finding', async () => {
  const result = await runSourceBoundSpecialistBrief({
    pendingActionId: 'action-1', briefIndex: 0,
    appUrl: 'https://app.invalid', token: 'test-token',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'continuation_source_status_mismatch' }), {
      status: 409, headers: { 'content-type': 'application/json' },
    }),
  })

  assert.deepEqual(result, {
    success: false, summary: '', error: 'specialist_chat_http_409',
  })
})
