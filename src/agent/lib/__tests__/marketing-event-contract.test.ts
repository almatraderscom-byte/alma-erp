import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockPrisma = vi.hoisted(() => ({
  agentMarketingEvent: {
    findUnique: vi.fn(),
    create: vi.fn(),
    groupBy: vi.fn(),
    updateMany: vi.fn(),
  },
}))
vi.mock('@/lib/prisma', () => ({ prisma: mockPrisma }))

beforeEach(() => vi.clearAllMocks())

import {
  EVENT_TAXONOMY,
  buildUserData,
  deterministicEventId,
  hashEmail,
  makeEvent,
  normalizeBdPhone,
  normalizeOccurredAt,
  recordEvent,
  validateEvent,
} from '@/agent/lib/marketing/event-contract'
import { buildCapiPayload } from '@/agent/lib/marketing/meta-capi'
import { buildUtm, buildCampaignSlug, parseLineage, validateUtm, applyUtmToUrl } from '@/agent/lib/marketing/utm'

describe('event taxonomy', () => {
  it('covers the whole funnel: page view → repeat', () => {
    expect(Object.keys(EVENT_TAXONOMY)).toEqual([
      'page_view', 'product_view', 'lead', 'messenger_conversation',
      'order_draft', 'order_confirmed', 'order_delivered', 'refund', 'repeat_purchase',
    ])
  })
})

describe('deterministic event ids — dedup identity', () => {
  it('same logical event from browser and server → same id', () => {
    const t = 1752700000
    const a = deterministicEventId({ name: 'order_confirmed', orderId: 'ORD-123', occurredAt: t })
    const b = deterministicEventId({ name: 'order_confirmed', orderId: 'ORD-123', occurredAt: t + 3600 }) // same day
    expect(a).toBe(b)
  })

  it('different order / different name → different id', () => {
    const t = 1752700000
    expect(deterministicEventId({ name: 'order_confirmed', orderId: 'ORD-1', occurredAt: t })).not.toBe(
      deterministicEventId({ name: 'order_confirmed', orderId: 'ORD-2', occurredAt: t }),
    )
    expect(deterministicEventId({ name: 'order_confirmed', orderId: 'ORD-1', occurredAt: t })).not.toBe(
      deterministicEventId({ name: 'order_delivered', orderId: 'ORD-1', occurredAt: t }),
    )
  })

  it('no identity at all → throws (no floating events)', () => {
    expect(() => deterministicEventId({ name: 'page_view', occurredAt: 1752700000 })).toThrow(/identity/)
  })
})

describe('PII normalization — raw identifiers never survive', () => {
  it('BD phone normalization handles 01/8801/+880 forms; rejects garbage', () => {
    expect(normalizeBdPhone('01712345678')).toBe('8801712345678')
    expect(normalizeBdPhone('+880 1712-345678')).toBe('8801712345678')
    expect(normalizeBdPhone('8801712345678')).toBe('8801712345678')
    expect(normalizeBdPhone('12345')).toBeNull()
  })

  it('buildUserData returns sha256 hex only', () => {
    const ud = buildUserData({ email: ' Boss@Example.COM ', phone: '01712345678' })!
    expect(ud.emailSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(ud.phoneSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(ud.emailSha256).toBe(hashEmail('boss@example.com'))
    expect(JSON.stringify(ud)).not.toContain('example.com')
    expect(JSON.stringify(ud)).not.toContain('01712')
  })

  it('validateEvent rejects raw PII smuggled into userData', () => {
    const e = makeEvent({ name: 'lead', source: 'server', occurredAt: Date.now(), dedupKey: 'lead-1' })
    const dirty = { ...e, userData: { emailSha256: 'boss@example.com' } }
    const v = validateEvent(dirty)
    expect(v.ok).toBe(false)
    expect(v.errors.join()).toContain('raw PII')
  })
})

describe('timestamp + money normalization', () => {
  it('accepts seconds, ms, ISO, Date; rejects future', () => {
    const now = Date.now()
    expect(normalizeOccurredAt(Math.floor(now / 1000), now)).toBe(Math.floor(now / 1000))
    expect(normalizeOccurredAt(now, now)).toBe(Math.floor(now / 1000))
    expect(normalizeOccurredAt(new Date(now), now)).toBe(Math.floor(now / 1000))
    expect(() => normalizeOccurredAt(now + 10 * 60_000, now)).toThrow(/future/)
  })

  it('makeEvent rounds value to whole taka and pins currency to BDT', () => {
    const e = makeEvent({ name: 'order_confirmed', source: 'erp', occurredAt: Date.now(), orderId: 'ORD-9', valueBdt: 1499.6 })
    expect(e.valueBdt).toBe(1500)
    expect(e.currency).toBe('BDT')
  })

  it('order events without orderId are rejected', () => {
    expect(() => makeEvent({ name: 'order_delivered', source: 'erp', occurredAt: Date.now(), dedupKey: 'x' })).toThrow(/orderId/)
  })
})

describe('recordEvent — duplicate test events do not double-count', () => {
  it('first arrival recorded, second deduped, no second insert', async () => {
    const e = makeEvent({ name: 'order_confirmed', source: 'server', occurredAt: Date.now(), orderId: 'ORD-77', valueBdt: 900 })
    mockPrisma.agentMarketingEvent.findUnique.mockResolvedValueOnce(null)
    mockPrisma.agentMarketingEvent.create.mockResolvedValueOnce({})
    expect(await recordEvent(e)).toBe('recorded')

    mockPrisma.agentMarketingEvent.findUnique.mockResolvedValueOnce({ id: 'row1', eventId: e.eventId })
    expect(await recordEvent(e)).toBe('deduped')
    expect(mockPrisma.agentMarketingEvent.create).toHaveBeenCalledTimes(1)
  })
})

describe('buildCapiPayload', () => {
  it('maps taxonomy → Meta names, carries event_id + hashed user_data + BDT', () => {
    const e = makeEvent({
      name: 'order_confirmed', source: 'server', occurredAt: Date.now(),
      orderId: 'ORD-5', valueBdt: 1200, rawUser: { phone: '01712345678' },
    })
    const payload = buildCapiPayload([e], { testEventCode: 'TEST99' })
    expect(payload.test_event_code).toBe('TEST99')
    const wire = payload.data[0]
    expect(wire.event_name).toBe('Purchase')
    expect(wire.event_id).toBe(e.eventId)
    expect(wire.user_data.ph![0]).toMatch(/^[a-f0-9]{64}$/)
    expect(wire.custom_data).toMatchObject({ currency: 'BDT', value: 1200, order_id: 'ORD-5' })
    expect(JSON.stringify(payload)).not.toContain('01712345678')
  })

  it('browser source → website action_source; messenger → chat', () => {
    const b = makeEvent({ name: 'product_view', source: 'browser', occurredAt: Date.now(), entityId: 'SKU-1' })
    const m = makeEvent({ name: 'messenger_conversation', source: 'server', occurredAt: Date.now(), dedupKey: 'conv-1' })
    const payload = buildCapiPayload([b, m])
    expect(payload.data[0].action_source).toBe('website')
    expect(payload.data[1].action_source).toBe('chat')
    expect(payload.test_event_code).toBeUndefined()
  })
})

describe('UTM governance', () => {
  it('builds convention campaign + lineage and parses it back', () => {
    const campaign = buildCampaignSlug({ objective: 'COD Orders', yyyymm: '202607', slug: 'Eid Drop' })
    expect(campaign).toBe('alma_cod_orders_202607_eid_drop')
    const utm = buildUtm({ source: 'meta', medium: 'paid_social', campaign, adsetKey: 'Broad-18-35', adKey: 'ad1', creativeKey: 'hook A' })
    expect(validateUtm(utm).ok).toBe(true)
    const lineage = parseLineage(utm)!
    expect(lineage).toEqual({ campaignKey: campaign, adsetKey: 'broad_18_35', adKey: 'ad1', creativeKey: 'hook_a' })
  })

  it('rejects off-convention values', () => {
    expect(validateUtm({ utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'alma_x_202607' }).ok).toBe(false)
    expect(validateUtm({ utm_source: 'meta', utm_medium: 'paid_social', utm_campaign: 'random_name' }).ok).toBe(false)
    expect(() => buildCampaignSlug({ objective: 'x', yyyymm: '26-07' })).toThrow(/yyyymm/)
  })

  it('applyUtmToUrl replaces existing utm params instead of duplicating', () => {
    const utm = buildUtm({ source: 'meta', medium: 'paid_social', campaign: 'alma_cod_202607' })
    const url = applyUtmToUrl('https://almalifestyle.com/p/panjabi?utm_source=old&x=1', utm)
    const u = new URL(url)
    expect(u.searchParams.get('utm_source')).toBe('meta')
    expect(u.searchParams.get('x')).toBe('1')
    expect(url.match(/utm_source/g)!.length).toBe(1)
  })
})
