import { beforeEach, describe, expect, it, vi } from 'vitest'

let kvStore: Record<string, string> = {}
const notifyCalls: Array<{ tier: number; title: string }> = []

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentKvSetting: {
      findUnique: vi.fn(async ({ where }: { where: { key: string } }) =>
        kvStore[where.key] != null ? { value: kvStore[where.key] } : null,
      ),
      upsert: vi.fn(async ({ where, create, update }: {
        where: { key: string }
        create: { key: string; value: string }
        update: { value: string }
      }) => {
        kvStore[where.key] = kvStore[where.key] != null ? update.value : create.value
        return { key: where.key, value: kvStore[where.key] }
      }),
    },
  },
}))

vi.mock('@/agent/lib/notify-owner', () => ({
  notifyOwner: vi.fn(async (opts: { tier: number; title: string }) => {
    notifyCalls.push({ tier: opts.tier, title: opts.title })
    return { channels: ['ntfy_general'], statuses: {} }
  }),
}))

import { handleAdsWebhook, parseAdsWebhookChange } from '../ads-webhooks'

describe('parseAdsWebhookChange', () => {
  it('parses effective_status via field_changed as tier-2', () => {
    const event = parseAdsWebhookChange({
      field: 'field_changed',
      value: { object_id: '123', object_type: 'ad', changed_fields: ['effective_status'] },
    })
    expect(event).not.toBeNull()
    expect(event!.tier).toBe(2)
    expect(event!.push).toBe(true)
    expect(event!.key).toBe('status:ad:123')
  })

  it('ignores field_changed without effective_status', () => {
    const event = parseAdsWebhookChange({
      field: 'field_changed',
      value: { object_id: '123', object_type: 'ad', changed_fields: ['name'] },
    })
    expect(event).toBeNull()
  })

  it('creative_fatigue HIGH pushes tier-2, LOW is silent', () => {
    const high = parseAdsWebhookChange({
      field: 'creative_fatigue',
      value: { adgroup_id: '9', creative_fatigue_level: 'HIGH' },
    })
    expect(high!.tier).toBe(2)
    expect(high!.push).toBe(true)

    const low = parseAdsWebhookChange({
      field: 'creative_fatigue',
      value: { adgroup_id: '9', creative_fatigue_level: 'LOW' },
    })
    expect(low!.push).toBe(false)
  })

  it('ad_recommendations keyed by hash', () => {
    const event = parseAdsWebhookChange({
      field: 'ad_recommendations',
      value: { recommendation_hash: 'abc', ad_object_ids: ['1', '2'], recommendation_type: 'AUTOFLOW_OPT_IN' },
    })
    expect(event!.tier).toBe(1)
    expect(event!.key).toBe('rec:abc:1,2')
  })

  it('unknown fields return null', () => {
    expect(parseAdsWebhookChange({ field: 'in_process_ad_objects', value: {} })).toBeNull()
  })
})

describe('handleAdsWebhook', () => {
  beforeEach(() => {
    kvStore = {}
    notifyCalls.length = 0
  })

  const envelope = (changes: object[]) => ({
    object: 'ad_account',
    entry: [{ id: 'act_1', time: 1782862117, changes }],
  })

  it('notifies once and dedupes the repeat delivery', async () => {
    const payload = envelope([
      { field: 'field_changed', value: { object_id: '55', object_type: 'campaign', changed_fields: ['effective_status'] } },
    ])
    const first = await handleAdsWebhook(payload)
    expect(first).toEqual({ received: 1, notified: 1 })

    const second = await handleAdsWebhook(payload)
    expect(second).toEqual({ received: 1, notified: 0 })
    expect(notifyCalls).toHaveLength(1)
  })

  it('ignores non-ad_account objects', async () => {
    const result = await handleAdsWebhook({ object: 'page', entry: [] })
    expect(result).toEqual({ received: 0, notified: 0 })
    expect(notifyCalls).toHaveLength(0)
  })
})
