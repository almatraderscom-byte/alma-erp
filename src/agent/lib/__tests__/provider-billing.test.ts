import { describe, expect, it } from 'vitest'
import {
  parseElevenLabsSubscription,
  parseFalUsage,
  parseGoogleBillingRows,
  parseOxylabsUsage,
  parseVercelFocusCharges,
  parseXaiBilling,
  roundProviderUsd,
} from '@/agent/lib/provider-billing'
import {
  hasPublishedProviderCost,
  mergeProviderInvoiceDues,
  normalizeCachedProvider,
  parseOpenAICostPage,
  providerLocalDeltaStart,
  summarizeSubscriptionDues,
} from '@/agent/lib/api-balances'

describe('provider billing parsers', () => {
  it('parses Vercel JSONL and uses billed cost in USD', () => {
    const raw = [
      JSON.stringify({
        BilledCost: '1.25',
        EffectiveCost: '1.10',
        BillingCurrency: 'USD',
        ChargePeriodStart: '2026-07-23T00:00:00Z',
      }),
      JSON.stringify({
        BilledCost: '2.50',
        BillingCurrency: 'USD',
        ChargePeriodStart: '2026-07-22T00:00:00Z',
      }),
    ].join('\n')

    expect(parseVercelFocusCharges(raw, '2026-07-23')).toEqual({
      todayUsd: 1.25,
      monthUsd: 3.75,
      syncedThrough: '2026-07-23',
    })
  })

  it('refuses to relabel a non-USD provider charge as USD', () => {
    expect(() => parseVercelFocusCharges(JSON.stringify({
      BilledCost: '100',
      BillingCurrency: 'EUR',
      ChargePeriodStart: '2026-07-23T00:00:00Z',
    }), '2026-07-23')).toThrow('billing currency EUR')
  })

  it('classifies Google billing export rows without mixing TTS and Veo into Gemini', () => {
    const fields = [
      { name: 'service' },
      { name: 'sku' },
      { name: 'usage_date' },
      { name: 'cost_usd' },
    ]
    const rows = [
      { f: [{ v: 'Gemini API' }, { v: 'Gemini 3.1 Pro input' }, { v: '2026-07-23' }, { v: '4.5' }] },
      { f: [{ v: 'Cloud Text-to-Speech API' }, { v: 'Chirp HD' }, { v: '2026-07-23' }, { v: '0.25' }] },
      { f: [{ v: 'Vertex AI' }, { v: 'Veo video generation' }, { v: '2026-07-22' }, { v: '1.75' }] },
    ]

    expect(parseGoogleBillingRows(fields, rows, '2026-07-23')).toEqual({
      gemini: { todayUsd: 4.5, monthUsd: 4.5, syncedThrough: '2026-07-23' },
      google_tts: { todayUsd: 0.25, monthUsd: 0.25, syncedThrough: '2026-07-23' },
      veo: { todayUsd: 0, monthUsd: 1.75, syncedThrough: '2026-07-22' },
    })
  })

  it('keeps provider precision without inventing whole cents', () => {
    expect(roundProviderUsd(0.0001478)).toBe(0.000148)
  })

  it('reads ElevenLabs quota and the provider-published next invoice', () => {
    expect(parseElevenLabsSubscription({
      tier: 'creator',
      character_count: 12_500,
      character_limit: 100_000,
      next_character_count_reset_unix: 1_775_059_200,
      currency: 'usd',
      has_open_invoices: false,
      current_overage: { amount: '3.25', currency: 'usd' },
      next_invoice: {
        amount_due_cents: 2_200,
        next_payment_attempt_unix: 1_775_059_200,
        payment_intent_status: 'scheduled',
      },
    })).toEqual({
      used: 12_500,
      limit: 100_000,
      remaining: 87_500,
      unit: 'characters',
      plan: 'creator',
      resetAt: '2026-04-01T16:00:00.000Z',
      subscription: null,
      onDemand: null,
      overage: {
        amount: 3.25,
        currency: 'USD',
      },
      invoice: {
        kind: 'next',
        amount: 22,
        currency: 'USD',
        dueAt: '2026-04-01T16:00:00.000Z',
        status: 'scheduled',
      },
    })
  })

  it('sums fal workspace usage in USD without losing sub-cent precision', () => {
    expect(parseFalUsage({
      time_series: [
        {
          bucket: '2026-07-23T00:00:00+06:00',
          results: [
            { cost: 0.0048, currency: 'USD' },
            { cost: 1.25, currency: 'USD' },
          ],
        },
      ],
    }, '2026-07-23')).toEqual({
      todayUsd: 1.2548,
      monthUsd: 1.2548,
      syncedThrough: '2026-07-23',
    })
  })

  it('sums Oxylabs official monthly request counts across products', () => {
    expect(parseOxylabsUsage({
      data: { products: [{ all_count: 41 }, { all_count: 9 }] },
    })).toEqual({
      amount: 50,
      unit: 'requests',
      period: 'month',
    })
  })

  it('parses xAI ledger balance, usage and current invoice preview', () => {
    expect(parseXaiBilling(
      { total: { val: '-1234' } },
      {
        timeSeries: [{
          dataPoints: [
            { timestamp: '2026-07-23T00:00:00Z', values: [0.25] },
            { timestamp: '2026-07-24T00:00:00Z', values: [0.5] },
          ],
        }],
      },
      { coreInvoice: { totalWithCorr: { val: '225' } } },
      '2026-07-24',
    )).toEqual({
      balanceUsd: 12.34,
      cost: {
        todayUsd: 0.5,
        monthUsd: 0.75,
        syncedThrough: '2026-07-24',
      },
      invoice: {
        kind: 'preview',
        amount: 2.25,
        currency: 'USD',
        dueAt: null,
        status: 'current preview',
      },
    })
  })

  it('reads OpenAI costs from bucket results and does not divide USD by 100', () => {
    expect(parseOpenAICostPage({
      data: [{
        start_time: Date.parse('2026-07-22T00:00:00Z') / 1_000,
        results: [
          { amount: { value: 0.06, currency: 'usd' } },
          { amount: { value: 1.24, currency: 'usd' } },
        ],
      }],
      has_more: true,
      next_page: 'next-token',
    })).toEqual({
      usd: 1.3,
      bucketCount: 1,
      syncedThrough: '2026-07-22',
      hasMore: true,
      nextPage: 'next-token',
    })
  })

  it('does not advance the OpenAI provider boundary for an unpublished empty bucket', () => {
    expect(parseOpenAICostPage({
      data: [
        {
          start_time: Date.parse('2026-07-22T00:00:00Z') / 1_000,
          results: [{ amount: { value: 0.8, currency: 'usd' } }],
        },
        {
          start_time: Date.parse('2026-07-23T00:00:00Z') / 1_000,
          results: [],
        },
      ],
    }).syncedThrough).toBe('2026-07-22')
  })

  it('does not treat an empty provider response as published cost truth', () => {
    expect(hasPublishedProviderCost({
      syncedThrough: null,
    })).toBe(false)
    expect(hasPublishedProviderCost({
      syncedThrough: '2026-07-23',
    })).toBe(true)
  })

  it('scrubs legacy manual balances and boundary-less confirmed cost from cache', () => {
    expect(normalizeCachedProvider({
      id: 'openai',
      label: 'OpenAI',
      balanceKind: 'manual_estimate',
      balanceAmount: -25.47,
      balanceUsd: -25.47,
      balanceCurrency: 'USD',
      balanceUnit: 'USD',
      providerMonthUsd: 0,
      monthUsd: 2.71,
      localDeltaUsd: 2.71,
      syncedThrough: null,
      costAuthoritative: true,
      authoritative: true,
      status: 'live',
      sourceType: 'manual',
      costSourceType: 'provider_api',
    }, '2026-07-24T00:00:00.000Z')).toMatchObject({
      balanceKind: 'none',
      balanceAmount: null,
      balanceUsd: null,
      balanceCurrency: null,
      balanceUnit: null,
      balanceAuthoritative: false,
      providerMonthUsd: null,
      localDeltaUsd: null,
      costSourceType: 'local_measured',
      costAuthoritative: false,
      authoritative: false,
      status: 'partial',
    })
  })

  it('uses the source timezone at the provider/local reconciliation boundary', () => {
    expect(providerLocalDeltaStart('openai', '2026-07-23')?.toISOString())
      .toBe('2026-07-24T00:00:00.000Z')
    expect(providerLocalDeltaStart('gemini', '2026-07-23')?.toISOString())
      .toBe('2026-07-23T18:00:00.000Z')
  })

  it('uses a pending invoice due/amount but ignores a settled invoice', () => {
    expect(summarizeSubscriptionDues([
      {
        nextRenewalAt: new Date('2026-08-10T00:00:00Z'),
        amount: '20',
        currency: 'USD',
        invoiceDueAt: new Date('2026-07-24T00:00:00Z'),
        invoiceAmount: '18.50',
        invoiceCurrency: 'USD',
        invoiceStatus: 'open',
      },
      {
        nextRenewalAt: new Date('2026-07-26T00:00:00Z'),
        amount: '25',
        currency: 'USD',
        invoiceDueAt: new Date('2026-07-23T00:00:00Z'),
        invoiceAmount: '999',
        invoiceCurrency: 'USD',
        invoiceStatus: 'paid',
      },
    ], '2026-07-23')).toEqual({
      dueNow: 0,
      dueWithin7Days: 2,
      dueWithin30Days: 2,
      amountsWithin30Days: [{ currency: 'USD', amount: 43.5 }],
    })
  })

  it('does not count a manual provider row twice when a live provider invoice exists', () => {
    const manual = summarizeSubscriptionDues([{
      providerId: null,
      name: 'ElevenLabs',
      nextRenewalAt: new Date('2026-07-25T00:00:00Z'),
      amount: '22',
      currency: 'USD',
      invoiceDueAt: null,
      invoiceAmount: null,
      invoiceCurrency: null,
      invoiceStatus: null,
    }], '2026-07-23', new Set(['elevenlabs']))
    expect(manual.dueWithin30Days).toBe(0)

    expect(mergeProviderInvoiceDues(manual, [{
      kind: 'next',
      amount: 22,
      currency: 'USD',
      dueAt: '2026-07-25T00:00:00Z',
      status: 'scheduled',
    }], '2026-07-23')).toEqual({
      dueNow: 0,
      dueWithin7Days: 1,
      dueWithin30Days: 1,
      amountsWithin30Days: [{ currency: 'USD', amount: 22 }],
    })
  })
})
