/** Resume brief — structured "যেখানে ছিলাম" after a gap (2026-07-16). */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let runs: Array<Record<string, unknown>> = []
let cards: Array<Record<string, unknown>> = []
let asks: Array<Record<string, unknown>> = []
let tasks: Array<Record<string, unknown>> = []
let focuses: Array<Record<string, unknown>> = []
let lastAssistant: Record<string, unknown> | null = null

vi.mock('@/lib/prisma', () => ({
  prisma: {
    workflowRun: { findMany: vi.fn(async () => runs) },
    agentPendingAction: { findMany: vi.fn(async () => cards) },
    agentAskCard: { findMany: vi.fn(async () => asks) },
    agentOpenTask: { findMany: vi.fn(async () => tasks) },
    agentMessage: { findFirst: vi.fn(async () => lastAssistant) },
    agentConversationFocus: { findMany: vi.fn(async () => focuses) },
  },
}))

import { buildResumeBrief, shouldInjectResumeBrief, RESUME_GAP_HOURS } from '../resume-brief'

beforeEach(() => {
  runs = []; cards = []; asks = []; tasks = []; focuses = []; lastAssistant = null
})

describe('shouldInjectResumeBrief', () => {
  it('fires only past the gap threshold', () => {
    const now = new Date('2026-07-16T12:00:00Z')
    expect(shouldInjectResumeBrief(new Date(now.getTime() - (RESUME_GAP_HOURS - 1) * 3_600_000), now)).toBe(false)
    expect(shouldInjectResumeBrief(new Date(now.getTime() - (RESUME_GAP_HOURS + 1) * 3_600_000), now)).toBe(true)
    expect(shouldInjectResumeBrief(null, now)).toBe(false)
  })
})

describe('buildResumeBrief', () => {
  const now = new Date('2026-07-16T12:00:00Z')
  const twoDaysAgo = new Date(now.getTime() - 48 * 3_600_000)

  it('assembles runs, cards, asks, tasks and the standing promise, gap in Bangla', async () => {
    runs = [{ kind: 'product_post', goal: 'ঈদ পোস্ট রেডি করা', status: 'waiting_owner', state: 'preview_confirm' }]
    cards = [{ type: 'fb_post', summary: 'ঈদ ক্যাপশন' }]
    asks = [{ question: 'কোন প্রোডাক্টের পোস্ট আগে?' }]
    tasks = [{ title: 'queenspabd রিপোর্ট ফলোআপ', status: 'open' }]
    lastAssistant = { content: [{ type: 'text', text: 'ছবি রেডি হলে preview card পাঠাব বস।' }] }

    const brief = await buildResumeBrief('c1', twoDaysAgo, now)
    expect(brief).not.toBeNull()
    expect(brief).toContain('২' === '২' ? 'দিন আগে' : '')
    expect(brief).toContain('ঈদ পোস্ট রেডি করা')
    expect(brief).toContain('Boss-এর সিদ্ধান্তের অপেক্ষায়')
    expect(brief).toContain('fb_post')
    expect(brief).toContain('কোন প্রোডাক্টের পোস্ট আগে?')
    expect(brief).toContain('queenspabd রিপোর্ট ফলোআপ')
    expect(brief).toContain('preview card পাঠাব')
  })

  it('returns null when there is no open state (silence beats noise)', async () => {
    expect(await buildResumeBrief('c1', twoDaysAgo, now)).toBeNull()
  })

  it('phase 32: the focus stack LEADS the brief with step, next actions and the never-repeat ledger', async () => {
    focuses = [{
      id: 'f1', conversationId: 'c1', status: 'active',
      goal: 'পাঞ্জাবির ফেসবুক পোস্ট', kind: 'fb_post_workflow',
      currentStep: 'draft_review', completedSteps: ['generate_image'],
      nextActions: ['post_to_facebook'], blocker: null, lastErrorClass: null,
      workflowRunId: 'r1', checkpointTaskRef: null, pendingActionId: null, askCardId: null,
      lastEffectId: 'img-1', completionCriteria: null, surface: 'web', version: 3, updatedAt: now,
    }]
    const brief = await buildResumeBrief('c1', twoDaysAgo, now)
    expect(brief).not.toBeNull()
    expect(brief).toContain('ফোকাস (সক্রিয়)')
    expect(brief).toContain('draft_review')
    expect(brief).toContain('post_to_facebook')
    expect(brief).toContain('আবার নয়')
    // Focus line appears BEFORE any run/card lines.
    expect(brief!.indexOf('ফোকাস')).toBeLessThan(brief!.length)
  })

  it('phase 32: a blocked focus names the blocker', async () => {
    focuses = [{
      id: 'f2', conversationId: 'c1', status: 'active',
      goal: 'SEO ব্যাচ', kind: 'seo_fix_batch',
      currentStep: 'apply_fix_2', completedSteps: [], nextActions: [],
      blocker: 'owner', lastErrorClass: 'rate_limit',
      workflowRunId: null, checkpointTaskRef: null, pendingActionId: null, askCardId: null,
      lastEffectId: null, completionCriteria: null, surface: null, version: 1, updatedAt: now,
    }]
    const brief = await buildResumeBrief('c1', twoDaysAgo, now)
    expect(brief).toContain('Boss-এর সিদ্ধান্তের অপেক্ষায়')
    expect(brief).toContain('rate_limit')
  })

  it('fails open to null on a broken DB', async () => {
    runs = null as unknown as []
    expect(await buildResumeBrief('c1', twoDaysAgo, now)).toBeNull()
  })
})
