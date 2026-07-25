/**
 * G5 + G6 (owner ruling 2026-07-26).
 *
 * G5 — a finished plan tells Boss in HIS chat. Until now the outcome sat in a
 * drive conversation he never opens, and the only nudge was a push that fires
 * solely when he is away.
 * G6 — a plan that cannot finish inside its time budget says so, with the reason,
 * instead of going quiet for an hour.
 */
import { describe, expect, it } from 'vitest'
import {
  buildPlanDeliveryMessage,
  elapsedBn,
  isOverBudget,
  lastStepResult,
  DEFAULT_PLAN_BUDGET_MIN,
} from '@/agent/lib/plan-driver/plan-delivery'

const step = (over: Record<string, unknown> = {}) => ({
  id: 's', action: 'ধাপ', dependsOn: [], status: 'done' as const,
  attemptCount: 0, maxAttempts: 3, ...over,
})

describe('lastStepResult', () => {
  it('takes the newest DONE step that actually produced text', () => {
    const plan = {
      steps: [
        step({ id: 's1', result: 'প্রথম ফল' }),
        step({ id: 's2', result: 'শেষ ফল' }),
        step({ id: 's3', status: 'pending' as const, result: 'অসমাপ্ত' }),
      ],
    }
    expect(lastStepResult(plan)).toBe('শেষ ফল')
  })

  it('is empty when nothing produced anything — never invents a result', () => {
    expect(lastStepResult({ steps: [step({ status: 'failed' as const, result: 'x' })] })).toBe('')
  })
})

describe('the message Boss reads', () => {
  const plan = {
    goal: 'গতকালের সেল কম — কারণ বের করো',
    steps: [step({ id: 's1', result: 'অ্যাড বন্ধ ছিল, তাই ট্রাফিক শূন্য' }), step({ id: 's2', status: 'pending' as const })],
  }

  it('a finished plan leads with the result, not with process', () => {
    const msg = buildPlanDeliveryMessage(plan, 'done', 'সব যাচাই হয়েছে')
    expect(msg).toContain('শেষ')
    expect(msg).toContain('অ্যাড বন্ধ ছিল')
    expect(msg).toContain('১/২ ধাপ'.replace('১/২', '1/2'))
  })

  it('a stopped plan says WHY and what he can do', () => {
    const msg = buildPlanDeliveryMessage(plan, 'stopped', 'করণীয় ঠিক করা হয়নি')
    expect(msg).toContain('আপনার সিদ্ধান্ত দরকার')
    expect(msg).toContain('করণীয় ঠিক করা হয়নি')
    expect(msg).toContain('এ পর্যন্ত যা পেয়েছি')
    expect(msg).toContain('আবার চালাও')
  })
})

describe('G6 time budget', () => {
  const budgetMs = DEFAULT_PLAN_BUDGET_MIN * 60_000
  const now = new Date('2026-07-26T12:00:00Z')

  it('an attempt inside its budget is left alone', () => {
    expect(isOverBudget(new Date('2026-07-26T11:45:00Z'), budgetMs, now)).toBe(false)
  })

  it('the hour-long silence he watched is over budget', () => {
    expect(isOverBudget(new Date('2026-07-26T11:00:00Z'), budgetMs, now)).toBe(true)
  })

  // Caught live the day G6 shipped: resuming a 2-hour-old plan blew the budget on
  // its first tick and escalated straight back at him, so "আবার চালাও" did nothing.
  it('measures the CURRENT attempt, so a resume genuinely restarts the clock', () => {
    const created = new Date('2026-07-26T09:00:00Z')      // 3 hours ago
    const resumedAt = new Date('2026-07-26T11:55:00Z')    // 5 minutes ago
    expect(isOverBudget(created, budgetMs, now)).toBe(true)
    expect(isOverBudget(resumedAt, budgetMs, now)).toBe(false)
  })

  it('reports the elapsed time in words he can read', () => {
    expect(elapsedBn(new Date('2026-07-26T11:20:00Z'), now)).toBe('40 মিনিট')
    expect(elapsedBn(new Date('2026-07-26T09:00:00Z'), now)).toBe('3 ঘণ্টা')
  })
})
