/**
 * Owner caught this himself, 2026-07-27: the green card said "আপনি অনুমোদন
 * করেছিলেন — কাজটি সম্পন্ন হয়েছে" for an SEO audit he had never seen. The row is
 * created already-approved on purpose (a read-only crawl needs no card), so no
 * card ever reached him — and then the record put words in his mouth.
 *
 * The signal is the approve route's own stamp: it always sets resolvedAt, so a
 * row without one was never his decision.
 */
import { describe, it, expect } from 'vitest'
import { resolvedRecordFor } from '@/agent/lib/approval-record'

describe('a record may only report a decision he actually made', () => {
  it('never claims he approved an auto-run row', () => {
    for (const status of ['approved', 'executed']) {
      const rec = resolvedRecordFor(status, false)
      expect(rec?.text).not.toContain('আপনি অনুমোদন করেছিলেন')
      expect(rec?.text).toContain('অনুমোদন লাগেনি')
    }
  })

  it('still says so when he DID approve', () => {
    expect(resolvedRecordFor('approved', true)?.text).toContain('আপনি অনুমোদন করেছিলেন')
    expect(resolvedRecordFor('executed', true)?.text).toContain('কাজটি সম্পন্ন হয়েছে')
  })

  it('an auto-run failure is reported as a failure, without blaming him', () => {
    const rec = resolvedRecordFor('failed', false)
    expect(rec?.text).toContain('ব্যর্থ')
    expect(rec?.text).not.toContain('অনুমোদন করেছিলেন')
  })

  it('unknown-provenance rows keep the old wording — no silent regression', () => {
    expect(resolvedRecordFor('approved', undefined)?.text).toContain('আপনি অনুমোদন করেছিলেন')
  })

  it('rejection is always his — nothing auto-rejects', () => {
    expect(resolvedRecordFor('rejected', false)?.text).toContain('বাতিল করেছিলেন')
  })

  it('returns nothing for a status it does not know', () => {
    expect(resolvedRecordFor(undefined, false)).toBeUndefined()
  })
})
