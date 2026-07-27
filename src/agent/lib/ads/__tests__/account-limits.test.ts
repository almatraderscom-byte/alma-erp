/**
 * ADS-2 phase C — the account cap.
 *
 * Boss asked "ads e roj koto kharoch hocche ar amar limit er moddhe achi kina"
 * on 2026-07-27. The honest answer was "আপনার cap আমার কাছে সেভ করা নেই" — and a
 * grep proved why: `spend_cap` appeared nowhere in this repo. Meta had been
 * exposing it on the ad account object all along.
 *
 * This exercises the REAL function against a mocked Graph response, because a
 * test that re-implements the ÷100 next to the assertion proves nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/agent/lib/fetch-retry', () => ({
  resilientFetch: (url: string) => mockFetch(url),
}))

let mockFetch: (url: string) => Promise<Response>
let lastUrl = ''

import { fetchAccountLimits } from '../insights'

const account = (body: Record<string, unknown>) => {
  mockFetch = (url: string) => {
    lastUrl = url
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }
}

beforeEach(() => {
  process.env.META_ADS_TOKEN = 'tok'
  process.env.META_AD_ACCOUNT_ID = 'act_1236291335314468'
})
afterEach(() => {
  delete process.env.META_ADS_TOKEN
  delete process.env.META_AD_ACCOUNT_ID
})

describe('fetchAccountLimits', () => {
  it('converts Meta’s minor units and computes what is left', async () => {
    account({ currency: 'USD', spend_cap: '50000', amount_spent: '2557', balance: '1000' })
    const r = await fetchAccountLimits()
    expect(r).toEqual({
      currency: 'USD',
      spendCap: 500,
      amountSpent: 25.57,
      balance: 10,
      remaining: 474.43,
    })
  })

  it('treats spend_cap 0 as NO cap set — not a cap of zero', async () => {
    // The difference matters: "no limit configured" and "limit reached" would
    // otherwise read identically, and one of them means stop spending.
    account({ currency: 'USD', spend_cap: '0', amount_spent: '2557' })
    const r = await fetchAccountLimits()
    expect(r.spendCap).toBeNull()
    expect(r.remaining).toBeNull()
  })

  it('never reports negative headroom once the cap is passed', async () => {
    account({ currency: 'USD', spend_cap: '1000', amount_spent: '2557' })
    expect((await fetchAccountLimits()).remaining).toBe(0)
  })

  it('asks Meta for the fields it needs, on the configured account', async () => {
    account({ currency: 'USD' })
    await fetchAccountLimits()
    expect(lastUrl).toContain('act_1236291335314468')
    expect(decodeURIComponent(lastUrl)).toContain('spend_cap')
    expect(decodeURIComponent(lastUrl)).toContain('amount_spent')
  })

  it('defaults the currency rather than throwing when Meta omits it', async () => {
    account({})
    expect((await fetchAccountLimits()).currency).toBe('USD')
  })
})
