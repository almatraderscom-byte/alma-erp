/**
 * Phase 32 — conversation focus store: stack semantics, optimistic
 * concurrency, append-only events, workflow-run bridge. In-memory prisma
 * fake — the store's queries are exercised against realistic filters.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Row = Record<string, unknown>
let focuses: Row[] = []
let events: Row[] = []
let nextId = 1

function matches(row: Row, where: Row): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v && typeof v === 'object' && 'in' in (v as Row)) {
      if (!((v as { in: unknown[] }).in as unknown[]).includes(row[k])) return false
    } else if (row[k] !== v) return false
  }
  return true
}

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentConversationFocus: {
      findMany: async ({ where, take }: { where: Row; take?: number }) =>
        focuses.filter((r) => matches(r, where)).slice(0, take ?? 100),
      findFirst: async ({ where }: { where: Row }) => focuses.find((r) => matches(r, where)) ?? null,
      findUnique: async ({ where }: { where: Row }) => focuses.find((r) => r.id === where.id) ?? null,
      create: async ({ data }: { data: Row }) => {
        const row = {
          id: `focus-${nextId++}`,
          version: 1,
          status: 'active',
          currentStep: null, completedSteps: null, lastEffectId: null, lastErrorClass: null,
          blocker: null, nextActions: null, completionCriteria: null, surface: null,
          checkpointTaskRef: null, openTaskId: null, pendingActionId: null, askCardId: null,
          workflowRunId: null,
          updatedAt: new Date(), createdAt: new Date(),
          ...data,
        }
        focuses.push(row)
        return row
      },
      updateMany: async ({ where, data }: { where: Row; data: Row }) => {
        const hits = focuses.filter((r) => matches(r, where))
        for (const r of hits) Object.assign(r, data, { updatedAt: new Date() })
        return { count: hits.length }
      },
    },
    agentFocusEvent: {
      create: async ({ data }: { data: Row }) => {
        events.push({ id: `ev-${events.length + 1}`, createdAt: new Date(), ...data })
        return events[events.length - 1]
      },
    },
  },
}))

import {
  createFocus,
  getFocusStack,
  updateFocus,
  parkActiveFocus,
  activateFocus,
  ensureFocusForWorkflowRun,
  syncFocusWithWorkflowRun,
  recordVerifiedEffect,
  buildFocusSystemNote,
  FocusVersionConflictError,
} from '@/agent/lib/conversation-focus'

beforeEach(() => {
  focuses = []
  events = []
  nextId = 1
})

describe('stack semantics', () => {
  it('creating a new active focus parks the previous one (never two active)', async () => {
    await createFocus({ conversationId: 'c1', goal: 'পোস্ট বানানো', kind: 'fb_post_workflow' })
    await createFocus({ conversationId: 'c1', goal: 'SEO ঠিক করা', kind: 'seo_fix_batch' })
    const stack = await getFocusStack('c1')
    expect(stack.active?.goal).toBe('SEO ঠিক করা')
    expect(stack.parked.map((f) => f.goal)).toEqual(['পোস্ট বানানো'])
    expect(events.filter((e) => e.type === 'parked')).toHaveLength(1)
    expect(events.filter((e) => e.type === 'created')).toHaveLength(2)
  })

  it('activateFocus resumes a parked focus and parks the current active', async () => {
    const a = await createFocus({ conversationId: 'c1', goal: 'A' })
    await createFocus({ conversationId: 'c1', goal: 'B' })
    await activateFocus(a!.id)
    const stack = await getFocusStack('c1')
    expect(stack.active?.goal).toBe('A')
    expect(stack.parked.map((f) => f.goal)).toEqual(['B'])
  })
})

describe('optimistic concurrency + append-only events', () => {
  it('a stale version write throws FocusVersionConflictError and changes nothing', async () => {
    const f = await createFocus({ conversationId: 'c1', goal: 'A' })
    await updateFocus({ focusId: f!.id, expectedVersion: 1, patch: { currentStep: 's2' } })
    await expect(
      updateFocus({ focusId: f!.id, expectedVersion: 1, patch: { currentStep: 'HIJACK' } }),
    ).rejects.toBeInstanceOf(FocusVersionConflictError)
    const stack = await getFocusStack('c1')
    expect(stack.active?.currentStep).toBe('s2')
    expect(stack.active?.version).toBe(2)
  })

  it('every successful write appends an event with the new version', async () => {
    const f = await createFocus({ conversationId: 'c1', goal: 'A' })
    await updateFocus({ focusId: f!.id, expectedVersion: 1, patch: { currentStep: 's2' } })
    const versions = events.map((e) => e.version)
    expect(versions).toContain(1)
    expect(versions).toContain(2)
  })
})

describe('workflow-run bridge', () => {
  const run = {
    id: 'run-1', conversationId: 'c1', kind: 'fb_post_workflow',
    goal: 'পাঞ্জাবির পোস্ট', status: 'active', state: 'draft_review',
    nextAllowedTools: ['post_to_facebook'],
  }

  it('ensureFocusForWorkflowRun creates once, then reuses', async () => {
    const first = await ensureFocusForWorkflowRun(run)
    const second = await ensureFocusForWorkflowRun(run)
    expect(first!.id).toBe(second!.id)
    expect(focuses).toHaveLength(1)
    expect(first!.nextActions).toEqual(['post_to_facebook'])
  })

  it('syncFocusWithWorkflowRun mirrors step/status/blocker and closes on terminal', async () => {
    await ensureFocusForWorkflowRun(run)
    await syncFocusWithWorkflowRun({ id: 'run-1', status: 'waiting_owner', state: 'approval_wait' })
    let stack = await getFocusStack('c1')
    expect(stack.awaitingOwner[0]?.currentStep).toBe('approval_wait')
    expect(stack.awaitingOwner[0]?.blocker).toBe('owner')

    await syncFocusWithWorkflowRun({ id: 'run-1', status: 'done', state: 'completed' })
    stack = await getFocusStack('c1')
    expect(stack.active).toBeNull()
    expect(stack.awaitingOwner).toHaveLength(0)
    expect(events.some((e) => e.type === 'completed')).toBe(true)
  })
})

describe('never-repeat ledger', () => {
  it('recordVerifiedEffect appends the effect and step', async () => {
    const f = await createFocus({ conversationId: 'c1', goal: 'A' })
    await recordVerifiedEffect(f!.id, 'generate_image:img-9', 'image_done')
    const stack = await getFocusStack('c1')
    expect(stack.active?.lastEffectId).toBe('generate_image:img-9')
    expect(stack.active?.completedSteps).toContain('image_done')
  })
})

describe('system note', () => {
  it('renders the canonical Bangla block with never-repeat + next steps', async () => {
    await createFocus({
      conversationId: 'c1', goal: 'পাঞ্জাবির ফেসবুক পোস্ট', kind: 'fb_post_workflow',
      currentStep: 'draft_review', nextActions: ['post_to_facebook'],
    })
    const f = (await getFocusStack('c1')).active!
    await recordVerifiedEffect(f.id, 'img-1', 'generate_image')
    const note = buildFocusSystemNote(await getFocusStack('c1'))
    expect(note).toContain('CONVERSATION FOCUS')
    expect(note).toContain('post_to_facebook')
    expect(note).toContain('generate_image')
    expect(note).toContain('আর করা নিষেধ')
  })

  it('empty stack renders nothing', async () => {
    expect(buildFocusSystemNote({ active: null, parked: [], awaitingOwner: [] })).toBe('')
  })
})
