import Ajv2020 from 'ajv/dist/2020'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import agentEventSchema from '../../protocol/agent-event.schema.json'
import {
  clearMatchingWorkStepsBlocker,
  parseWorkStepsSnapshot,
  projectRuntimeWorkSteps,
  projectWorkSteps,
  rememberedWorkStepsBlockerForRefresh,
  reconcileDurableWorkStepsBlocker,
  synchronizedWorkStepsBlocker,
  workStepsSignature,
  type TrackerPlanRow,
  type WorkStepsSnapshot,
} from '../work-steps'

const NOW = new Date('2026-08-11T06:00:00.000Z')

function planRow(overrides: Partial<TrackerPlanRow> = {}): TrackerPlanRow {
  return {
    id: 'plan-1',
    conversationId: 'conversation-1',
    goal: 'Prepare the requested deliverable',
    status: 'executing',
    originTurnId: 'turn-1',
    originAssistantMessageId: null,
    trackerSnapshot: null,
    trackerRevision: 0,
    steps: [
      { id: 's1', seq: 1, action: 'Inspect the request', status: 'done', startedAt: NOW, doneAt: NOW, turnId: null },
      { id: 's2', seq: 2, action: 'Draft the output', status: 'running', startedAt: NOW, doneAt: null, turnId: null },
      { id: 's3', seq: 3, action: 'Verify the result', status: 'pending', startedAt: null, doneAt: null, turnId: null },
    ],
    ...overrides,
  }
}

describe('work_steps_snapshot projector', () => {
  it('clears only the callback-owned blocker and preserves a newer card/action', () => {
    const newer = { kind: 'question' as const, refId: 'ask-new' }
    expect(clearMatchingWorkStepsBlocker(newer, 'action-old')).toEqual(newer)
    expect(clearMatchingWorkStepsBlocker(newer, 'ask-new')).toBeNull()
  })

  it('preserves a queued worker blocker across generic running-step refreshes', () => {
    const worker = { kind: 'worker' as const, refId: 'action-queued' }
    const approval = { kind: 'approval' as const, refId: 'action-pending' }
    expect(rememberedWorkStepsBlockerForRefresh(worker, true)).toEqual(worker)
    expect(rememberedWorkStepsBlockerForRefresh(approval, true)).toBeNull()
    expect(rememberedWorkStepsBlockerForRefresh(approval, false)).toEqual(approval)
  })

  it('does not let an overlapping refresh clear a durable blocker with local null', () => {
    const approval = { kind: 'approval' as const, refId: 'action-new' }
    const worker = { kind: 'worker' as const, refId: 'worker-new' }
    for (const blocker of [approval, worker]) {
      expect(synchronizedWorkStepsBlocker({
        requested: null,
        remembered: blocker,
        hasRunningStep: true,
      })).toEqual(blocker)
      expect(synchronizedWorkStepsBlocker({
        requested: undefined,
        remembered: blocker,
        clearRefId: blocker.refId,
        hasRunningStep: true,
      })).toBeNull()
    }
  })

  it('never restores a blocker whose durable card/action is already terminal', () => {
    const approval = { kind: 'approval' as const, refId: 'action-1' }
    const worker = { kind: 'worker' as const, refId: 'action-1' }
    const question = { kind: 'question' as const, refId: 'ask-1' }
    expect(reconcileDurableWorkStepsBlocker(worker, 'pending')).toEqual(approval)
    expect(reconcileDurableWorkStepsBlocker(approval, 'approved')).toEqual(worker)
    expect(reconcileDurableWorkStepsBlocker(worker, 'executed')).toBeNull()
    expect(reconcileDurableWorkStepsBlocker(worker, 'failed')).toBeNull()
    expect(reconcileDurableWorkStepsBlocker(question, 'answered')).toBeNull()
    expect(reconcileDurableWorkStepsBlocker(question, 'pending')).toEqual(question)
  })

  it('casts the advisory lock result so Prisma never deserializes PostgreSQL void', () => {
    const source = readFileSync(new URL('../work-steps.ts', import.meta.url), 'utf8')
    expect(source).toContain(
      'pg_advisory_xact_lock(hashtext(${planId}))::text AS lock_token',
    )
  })

  it('projects durable plan rows and validates against the canonical schema', () => {
    const snapshot = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: true, now: NOW,
    })
    expect(snapshot.status).toBe('running')
    expect(snapshot.steps.map((s) => s.status)).toEqual(['completed', 'running', 'pending'])
    expect(snapshot.trackerId).toBe('plan-1')
    expect(snapshot.originTurnId).toBe('turn-1')
    expect(snapshot.turnIds).toEqual(['turn-1'])
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(agentEventSchema)
    expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true)
  })

  it('never claims completion without full durable evidence', () => {
    const snapshot = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: false, now: NOW,
    })
    // Steps remain, nothing running, no blocker → honest paused, not completed.
    expect(snapshot.status).toBe('paused')
    const done = projectWorkSteps({
      plan: planRow({
        status: 'done',
        steps: planRow().steps.map((s) => ({ ...s, status: 'done', doneAt: NOW })),
      }),
      currentTurnId: 'turn-1', revision: 2, blockedBy: null, live: false, now: NOW,
    })
    expect(done.status).toBe('completed')
    expect(done.headline).toContain('৩/৩')
  })

  it('surfaces an emitted approval card as a waiting_owner blocker on the active step', () => {
    const snapshot = projectWorkSteps({
      plan: planRow(),
      currentTurnId: 'turn-1',
      revision: 2,
      blockedBy: { kind: 'approval', refId: 'action-9' },
      live: true,
      now: NOW,
    })
    expect(snapshot.status).toBe('waiting_owner')
    expect(snapshot.blockedBy).toEqual({ kind: 'approval', refId: 'action-9' })
    expect(snapshot.steps[1].status).toBe('waiting_owner')
  })

  it('treats a step dispatched to another worker turn as waiting_worker', () => {
    const plan = planRow({
      steps: [
        { id: 's1', seq: 1, action: 'Kick off the long job', status: 'running', startedAt: NOW, doneAt: null, turnId: 'worker-turn-7' },
      ],
    })
    const snapshot = projectWorkSteps({
      plan, currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: true, now: NOW,
    })
    expect(snapshot.steps[0].status).toBe('waiting_worker')
    expect(snapshot.status).toBe('waiting_worker')
  })

  it('projects an action-linked queued step as waiting_worker', () => {
    const snapshot = projectWorkSteps({
      plan: planRow(),
      currentTurnId: 'turn-1',
      revision: 2,
      blockedBy: { kind: 'worker', refId: 'action-queued' },
      live: true,
      now: NOW,
    })
    expect(snapshot.status).toBe('waiting_worker')
    expect(snapshot.steps[1].status).toBe('waiting_worker')
    expect(snapshot.headline).toBe('Worker-এ কাজ চলছে')
  })

  it('chains continuation turns without duplicating the tracker', () => {
    const first = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: true, now: NOW,
    })
    const continued = projectWorkSteps({
      plan: planRow({ trackerSnapshot: first, trackerRevision: 1 }),
      currentTurnId: 'turn-2', revision: 2, blockedBy: null, live: true, now: NOW,
    })
    expect(continued.trackerId).toBe(first.trackerId)
    expect(continued.originTurnId).toBe('turn-1')
    expect(continued.currentTurnId).toBe('turn-2')
    expect(continued.turnIds).toEqual(['turn-1', 'turn-2'])
  })

  it('emits no estimated percentage and no hidden-reasoning field', () => {
    const snapshot = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: true, now: NOW,
    })
    const json = JSON.stringify(snapshot)
    for (const banned of ['percent', 'reasoning', 'thinking', 'chainOfThought', 'prompt']) {
      expect(json.toLowerCase()).not.toContain(banned.toLowerCase())
    }
  })

  it('signature changes only on meaningful state transitions', () => {
    const a = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: true, now: NOW,
    })
    const b = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 2, blockedBy: null, live: true,
      now: new Date(NOW.getTime() + 60_000),
    })
    // Same statuses, later timestamp/revision → identical signature (no wallpaper).
    expect(workStepsSignature(a)).toBe(workStepsSignature(b))
    const c = projectWorkSteps({
      plan: planRow({
        steps: planRow().steps.map((s, i) => i === 1 ? { ...s, status: 'done', doneAt: NOW } : s),
      }),
      currentTurnId: 'turn-1', revision: 3, blockedBy: null, live: true, now: NOW,
    })
    expect(workStepsSignature(c)).not.toBe(workStepsSignature(a))
  })

  it('parses only well-formed snapshots of this major version', () => {
    const snapshot = projectWorkSteps({
      plan: planRow(), currentTurnId: 'turn-1', revision: 1, blockedBy: null, live: true, now: NOW,
    })
    expect(parseWorkStepsSnapshot(snapshot)).not.toBeNull()
    expect(parseWorkStepsSnapshot(null)).toBeNull()
    expect(parseWorkStepsSnapshot({ ...snapshot, version: 2 })).toBeNull()
    expect(parseWorkStepsSnapshot({ ...snapshot, steps: 'nope' })).toBeNull()
  })

  it('runtime projector: honest macro phases for unplanned turns, evidence only', () => {
    const working = projectRuntimeWorkSteps({
      turnId: 'turn-9', conversationId: 'conversation-1',
      goal: 'Last 30 days order report', revision: 1, phase: 'working',
      completedToolRounds: 2, verificationHappened: false, blockedBy: null, now: NOW,
    })
    expect(working.source).toBe('turn_runtime')
    expect(working.trackerId).toBe('turn:turn-9')
    expect(working.status).toBe('running')
    expect(working.steps.map((s) => s.status)).toEqual(['completed', 'running'])
    // No verify step unless the honesty guard actually retried; no answer
    // step before delivery actually starts — nothing speculative.
    expect(working.steps.some((s) => s.title.includes('যাচাই'))).toBe(false)
    const validate = new Ajv2020({ strict: false, allErrors: true }).compile(agentEventSchema)
    expect(validate(working), JSON.stringify(validate.errors)).toBe(true)

    const settled = projectRuntimeWorkSteps({
      turnId: 'turn-9', conversationId: 'conversation-1',
      goal: 'Last 30 days order report', revision: 3, phase: 'settled',
      completedToolRounds: 4, verificationHappened: true, blockedBy: null, now: NOW,
    })
    expect(settled.status).toBe('completed')
    expect(settled.steps.map((s) => s.title.slice(0, 4))).toEqual(
      ['অনুর', 'তথ্য', 'উত্ত', 'উত্ত'])
    expect(settled.steps.every((s) => s.status === 'completed')).toBe(true)
    expect(validate(settled), JSON.stringify(validate.errors)).toBe(true)

    const waiting = projectRuntimeWorkSteps({
      turnId: 'turn-9', conversationId: 'conversation-1',
      goal: 'ছবি বানাও', revision: 2, phase: 'working',
      completedToolRounds: 1, verificationHappened: false,
      blockedBy: { kind: 'approval', refId: 'action-1' }, now: NOW,
    })
    expect(waiting.status).toBe('waiting_owner')
    expect(waiting.steps.find((s) => s.status === 'waiting_owner')).toBeTruthy()
  })

  it('terminal snapshots dominate: cancelled/failed plans project terminally', () => {
    for (const [planStatus, expected] of [
      ['abandoned', 'cancelled'],
      ['cancelled', 'cancelled'],
      ['failed', 'failed'],
    ] as const) {
      const snapshot: WorkStepsSnapshot = projectWorkSteps({
        plan: planRow({ status: planStatus }),
        currentTurnId: 'turn-1', revision: 5, blockedBy: null, live: true, now: NOW,
      })
      expect(snapshot.status).toBe(expected)
    }
  })

  it('names each tool call instead of collapsing them into a round count', () => {
    const snap = projectRuntimeWorkSteps({
      turnId: 't-tools',
      conversationId: 'c-1',
      goal: 'আজকের অবস্থা',
      revision: 1,
      phase: 'working',
      completedToolRounds: 3,
      verificationHappened: false,
      blockedBy: null,
      toolCalls: [
        { id: 'a', toolName: 'get_orders', status: 'success' },
        { id: 'b', toolName: 'get_orders', status: 'success' },
        { id: 'c', toolName: 'get_inventory_status', status: 'success' },
      ],
    })
    const titles = snap.steps.map((s) => s.title)
    // The repeat collapses: two reads of the same list is one thing being done.
    expect(titles).toEqual(['অনুরোধ বুঝে নেওয়া', 'ERP অর্ডার চেক করছি', 'স্টক/ইনভেন্টরি দেখছি'])
    expect(titles.some((t) => t.includes('ধাপ টুল-কাজ'))).toBe(false)
  })

  it('marks a failed tool call as failed, not silently completed', () => {
    const snap = projectRuntimeWorkSteps({
      turnId: 't-fail',
      conversationId: 'c-1',
      goal: 'স্টক',
      revision: 1,
      phase: 'settled',
      completedToolRounds: 1,
      verificationHappened: false,
      blockedBy: null,
      toolCalls: [{ id: 'a', toolName: 'get_inventory_status', status: 'error' }],
    })
    expect(snap.steps.find((s) => s.title === 'স্টক/ইনভেন্টরি দেখছি')?.status).toBe('failed')
  })

  it('falls back to the round count when no per-call detail is given', () => {
    const snap = projectRuntimeWorkSteps({
      turnId: 't-old',
      conversationId: 'c-1',
      goal: 'x',
      revision: 1,
      phase: 'working',
      completedToolRounds: 3,
      verificationHappened: false,
      blockedBy: null,
    })
    expect(snap.steps.some((s) => s.title.includes('ধাপ টুল-কাজ'))).toBe(true)
  })

  it('keeps the later failure when the same tool is retried', () => {
    const snap = projectRuntimeWorkSteps({
      turnId: 't-retry',
      conversationId: 'c-1',
      goal: 'স্টক',
      revision: 1,
      phase: 'settled',
      completedToolRounds: 2,
      verificationHappened: false,
      blockedBy: null,
      toolCalls: [
        { id: 'a', toolName: 'get_inventory_status', status: 'success' },
        { id: 'b', toolName: 'get_inventory_status', status: 'error' },
      ],
    })
    // One step (a retry is one thing being done) — and it reports the outcome the
    // turn actually ended with, not the first attempt.
    expect(snap.steps.filter((s) => s.title === 'স্টক/ইনভেন্টরি দেখছি')).toHaveLength(1)
    expect(snap.steps.find((s) => s.title === 'স্টক/ইনভেন্টরি দেখছি')?.status).toBe('failed')
  })

  it('does not claim every step finished when one failed', () => {
    const snap = projectRuntimeWorkSteps({
      turnId: 't-headline',
      conversationId: 'c-1',
      goal: 'স্টক',
      revision: 1,
      phase: 'settled',
      completedToolRounds: 1,
      verificationHappened: false,
      blockedBy: null,
      toolCalls: [{ id: 'a', toolName: 'get_inventory_status', status: 'error' }],
    })
    expect(snap.headline).toContain('ব্যর্থ')
    expect(snap.headline).not.toBe(`${'৩'}/${'৩'} ধাপ শেষ`)
  })
})
