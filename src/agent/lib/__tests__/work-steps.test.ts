import Ajv2020 from 'ajv/dist/2020'
import { describe, expect, it } from 'vitest'
import agentEventSchema from '../../protocol/agent-event.schema.json'
import {
  parseWorkStepsSnapshot,
  projectWorkSteps,
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
})
