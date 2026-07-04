/**
 * P0 terminal-state contract — hard verification against an in-memory prisma
 * double: failures write self-contained checkpoints, retries UPDATE (never
 * stack), success resolves, the watchdog turns silence into a checkpoint with
 * exactly ONE owner ping, and the resume note carries everything a fresh
 * context needs (no history re-read).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type TaskRow = {
  id: string
  businessId: string
  conversationId: string | null
  title: string
  kind: string
  status: string
  resumeNote: string
  checkpoint: Record<string, unknown> | null
  pendingActionId: string | null
  completedAt: Date | null
  updatedAt: Date
}
type ActionRow = {
  id: string
  type: string
  status: string
  summary: string | null
  conversationId: string | null
  payload: Record<string, unknown>
  resolvedAt: Date | null
  createdAt: Date
}

const tasks: TaskRow[] = []
const actions: ActionRow[] = []
let idc = 0
const pings: string[] = []

function matchWhere(row: TaskRow, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    const val = (row as Record<string, unknown>)[k]
    if (v && typeof v === 'object' && 'in' in (v as object)) {
      if (!(v as { in: unknown[] }).in.includes(val)) return false
    } else if (val !== v) return false
  }
  return true
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentOpenTask: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        tasks.find((t) => matchWhere(t, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        tasks.filter((t) => matchWhere(t, where)),
      create: async ({ data }: { data: Omit<TaskRow, 'id' | 'completedAt' | 'updatedAt'> }) => {
        const row: TaskRow = { ...data, id: `task-${++idc}`, completedAt: null, updatedAt: new Date() }
        tasks.push(row)
        return row
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<TaskRow> }) => {
        const row = tasks.find((t) => t.id === where.id)!
        Object.assign(row, data, { updatedAt: new Date() })
        return row
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<TaskRow> }) => {
        const hits = tasks.filter((t) => matchWhere(t, where))
        for (const h of hits) Object.assign(h, data)
        return { count: hits.length }
      },
    },
    agentPendingAction: {
      findMany: async ({ where }: { where: { createdAt: { lt: Date }; type: { in: string[] } } }) =>
        actions.filter(
          (a) =>
            a.status === 'approved' &&
            a.resolvedAt === null &&
            a.createdAt < where.createdAt.lt &&
            where.type.in.includes(a.type),
        ),
    },
  },
}))

vi.mock('@/agent/lib/telegram-owner-notify', () => ({
  sendOwnerText: async (text: string) => {
    pings.push(text)
    return { ok: true }
  },
}))

import {
  writeCheckpoint,
  resolveCheckpointByTaskRef,
  listUnresolvedCheckpoints,
  buildCheckpointSystemNote,
  runStuckTaskWatchdogTick,
} from '@/agent/lib/checkpoint'

beforeEach(() => {
  tasks.length = 0
  actions.length = 0
  pings.length = 0
  idc = 0
})

const baseInput = {
  taskRef: 'action-1',
  taskType: 'browser_action',
  goal: 'competitor price research',
  summaryBn: 'দাম গবেষণার কাজ মাঝপথে থেমেছে।',
  doneSteps: ['site A read'],
  currentStep: 'site B pagination',
  artifacts: ['generated/partial.csv'],
  error: 'timeout',
  nextActions: ['retry from site B'],
  resumeHint: 'Resume at site B page 3; partial CSV saved.',
  conversationId: 'conv-1',
}

describe('writeCheckpoint', () => {
  it('creates an open chip row with the structured state', async () => {
    const id = await writeCheckpoint(baseInput)
    expect(id).toBeTruthy()
    const row = tasks[0]
    expect(row.kind).toBe('checkpoint_failed')
    expect(row.status).toBe('open')
    expect(row.title).toContain('আটকে গেছে')
    expect(row.resumeNote).toContain('Resume at site B')
    expect((row.checkpoint as { currentStep: string }).currentStep).toBe('site B pagination')
  })

  it('a second failure for the same taskRef UPDATES the row — no chip stacking', async () => {
    await writeCheckpoint(baseInput)
    await writeCheckpoint({ ...baseInput, error: 'timeout again', currentStep: 'site B page 4' })
    expect(tasks).toHaveLength(1)
    expect((tasks[0].checkpoint as { currentStep: string }).currentStep).toBe('site B page 4')
  })

  it('waiting_for_owner carries the question', async () => {
    await writeCheckpoint({ ...baseInput, taskRef: 'plan:9', state: 'waiting_for_owner', question: 'কোন অপশন নিবো?' })
    expect(tasks[0].kind).toBe('checkpoint_waiting')
    expect(tasks[0].resumeNote).toContain('কোন অপশন নিবো?')
  })

  it('never throws even when the store explodes', async () => {
    const bad = { ...baseInput, taskRef: undefined as unknown as string }
    await expect(writeCheckpoint(bad)).resolves.toBeDefined()
  })
})

describe('resolve + resume note', () => {
  it('success on retry closes the checkpoint', async () => {
    await writeCheckpoint(baseInput)
    await resolveCheckpointByTaskRef('action-1')
    expect(tasks[0].status).toBe('done')
  })

  it('resume note is self-contained (goal, done, stuck point, artifacts, hint)', async () => {
    await writeCheckpoint(baseInput)
    const cps = await listUnresolvedCheckpoints('conv-1')
    expect(cps).toHaveLength(1)
    const note = buildCheckpointSystemNote(cps)
    for (const piece of ['competitor price research', 'site A read', 'site B pagination', 'generated/partial.csv', 'Resume at site B']) {
      expect(note).toContain(piece)
    }
    expect(note).toContain('ইতিহাস আবার পড়া')
  })

  it('resolved checkpoints stop appearing in the resume list', async () => {
    await writeCheckpoint(baseInput)
    await resolveCheckpointByTaskRef('action-1')
    expect(await listUnresolvedCheckpoints('conv-1')).toHaveLength(0)
    expect(buildCheckpointSystemNote([])).toBe('')
  })
})

describe('stuck-task watchdog', () => {
  it('turns a silent stuck job into a checkpoint + exactly one ping', async () => {
    actions.push({
      id: 'action-stuck',
      type: 'image_gen',
      status: 'approved',
      summary: '🎨 Studio try-on',
      conversationId: 'conv-2',
      payload: {},
      resolvedAt: null,
      createdAt: new Date(Date.now() - 45 * 60 * 1000),
    })
    const first = await runStuckTaskWatchdogTick()
    expect(first).toEqual({ stuck: 1, pinged: 1 })
    expect(pings[0]).toContain('আটকে গেছে')
    expect(tasks[0].kind).toBe('checkpoint_failed')

    // second tick: refreshes the same checkpoint, NO second ping
    const second = await runStuckTaskWatchdogTick()
    expect(second).toEqual({ stuck: 1, pinged: 0 })
    expect(tasks).toHaveLength(1)
    expect(pings).toHaveLength(1)
  })

  it('fresh jobs are left alone', async () => {
    actions.push({
      id: 'action-fresh',
      type: 'video_gen',
      status: 'approved',
      summary: 'reel',
      conversationId: null,
      payload: {},
      resolvedAt: null,
      createdAt: new Date(Date.now() - 5 * 60 * 1000),
    })
    expect(await runStuckTaskWatchdogTick()).toEqual({ stuck: 0, pinged: 0 })
    expect(tasks).toHaveLength(0)
  })
})
