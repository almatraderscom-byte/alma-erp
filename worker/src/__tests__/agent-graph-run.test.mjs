/**
 * Phase 35 — durable agent-graph-run contract: checkpoint/resume without
 * duplicated work, heartbeat, cancellation, deadline, failure isolation.
 * Run with: node --test worker/src/__tests__/agent-graph-run.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentGraphRunner } from '../agent-graph-run.mjs'

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
