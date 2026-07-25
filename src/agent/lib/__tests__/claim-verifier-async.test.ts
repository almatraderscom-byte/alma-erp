/**
 * Queued ≠ finished (owner incident 2026-07-25).
 *
 * `run_website_seo_audit` inserts one row and returns success in ~200 ms. The
 * ledger check counted that as a completed write, so the head could say
 * "৪০ পেজের ডিপ অডিট সম্পন্ন" five seconds after the crawl was handed to the
 * worker, and nothing objected. A completion claim about worker-run work now
 * needs a check_* tool that actually saw status "executed".
 */
import { describe, expect, it } from 'vitest'
import {
  detectAsyncCompletionViolation,
  detectLedgerViolations,
  summarizeAsyncJobEvidence,
} from '@/agent/lib/claim-verifier'

const queued = { toolName: 'run_website_seo_audit', status: 'success' as const, output: { data: { pendingActionId: 'a1' } } }
const polledRunning = { toolName: 'check_website_seo_audit', status: 'success' as const, output: { data: { status: 'approved' } } }
const polledDone = { toolName: 'check_website_seo_audit', status: 'success' as const, output: { data: { status: 'executed' } } }

describe('async job evidence', () => {
  it('a queue insert alone is a pending job, not a finished one', () => {
    expect(summarizeAsyncJobEvidence([queued])).toEqual({ pendingJobSeen: true, executedConfirmed: false })
  })

  it('a poll that still says "approved" keeps the job pending', () => {
    expect(summarizeAsyncJobEvidence([polledRunning])).toEqual({ pendingJobSeen: true, executedConfirmed: false })
  })

  it('a poll that says "executed" is the evidence a completion claim needs', () => {
    expect(summarizeAsyncJobEvidence([queued, polledDone]).executedConfirmed).toBe(true)
  })
})

describe('completion claims about queued work', () => {
  const pending = { pendingJobSeen: true, executedConfirmed: false }

  it.each([
    'Boss, almatraders.com এর ৪০ পেজের ডিপ SEO অডিট সম্পন্ন হয়েছে।',
    'Boss, পুরো সাইটের crawl শেষ হয়েছে — রিপোর্ট রেডি।',
    'The full audit is done, Boss.',
  ])('blocks: %s', (text) => {
    const v = detectAsyncCompletionViolation(text, pending)
    expect(v).toHaveLength(1)
    expect(v[0].category).toBe('async_unverified')
  })

  it.each([
    'Boss, ৪০ পেজের crawl worker-এ চলছে — শেষ হলেই পুরো রিপোর্ট নিজে থেকেই দেবো।',
    'অডিট queued হয়েছে, এখনো শেষ হয়নি।',
    'Audit শুরু করেছি, কিছুক্ষণ পর ফলাফল জানাবো।',
  ])('allows honest progress language: %s', (text) => {
    expect(detectAsyncCompletionViolation(text, pending)).toEqual([])
  })

  it('allows the completion claim once the poll confirmed executed', () => {
    const text = 'Boss, অডিট সম্পন্ন হয়েছে — স্কোর ২৪/১০০, ৩টা critical সমস্যা।'
    expect(detectAsyncCompletionViolation(text, { pendingJobSeen: true, executedConfirmed: true })).toEqual([])
  })

  it('is silent when no async job was involved at all', () => {
    const text = 'কাজটা সম্পন্ন হয়েছে।'
    expect(detectAsyncCompletionViolation(text, { pendingJobSeen: false, executedConfirmed: false })).toEqual([])
  })
})

describe('queue tools no longer satisfy the write ledger', () => {
  it('"সম্পন্ন হয়েছে" after only a queue insert is a ledger violation too', () => {
    const violations = detectLedgerViolations(
      'Boss, ডিপ SEO অডিট সম্পন্ন হয়েছে — ৪০টা পেজ দেখা হয়েছে।',
      [{ toolName: 'run_website_seo_audit', success: true }],
    )
    expect(violations).toHaveLength(1)
    expect(violations[0].ruleId).toBe('ledger_no_write_tool')
  })

  it('a genuine write tool still backs a completion claim', () => {
    expect(
      detectLedgerViolations('Boss, মেসেজটা পাঠিয়ে দিয়েছি।', [{ toolName: 'send_whatsapp', success: true }]),
    ).toEqual([])
  })
})
