import { beforeEach, describe, expect, it, vi } from 'vitest'

let kvStore: Record<string, string> = {}
const notifyCalls: Array<{ tier: number; title: string; actionUrl?: string | null }> = []

/** In-memory stand-in for the agent_ads_events table (dedupeKey → row). */
type EventRow = {
  id: string
  dedupeKey: string
  status: string
  notifyCount: number
  lastNotifiedAt: Date | null
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any
}
let eventStore: Record<string, EventRow> = {}
/** Set to make every agent_ads_events call throw (DB-down / degraded path). */
let eventsDown = false
/** Set to make every push channel fail (transport outage). */
let deliveryFails = false

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
    agentAdsEvent: {
      findUnique: vi.fn(async ({ where }: { where: { dedupeKey?: string; id?: string } }) => {
        if (eventsDown) throw new Error('db down')
        if (where.dedupeKey) return eventStore[where.dedupeKey] ?? null
        return Object.values(eventStore).find((r) => r.id === where.id) ?? null
      }),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { dedupeKey: string }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          create: any
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          update: any
        }) => {
          if (eventsDown) throw new Error('db down')
          const existing = eventStore[where.dedupeKey]
          if (!existing) {
            eventStore[where.dedupeKey] = { id: `evt-${Object.keys(eventStore).length + 1}`, ...create }
          } else {
            const inc = update.notifyCount?.increment
            eventStore[where.dedupeKey] = {
              ...existing,
              ...update,
              notifyCount: inc ? existing.notifyCount + inc : existing.notifyCount,
            }
          }
          return eventStore[where.dedupeKey]
        },
      ),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: any }) => {
        if (eventsDown) throw new Error('db down')
        const row = Object.values(eventStore).find((r) => r.id === where.id)
        if (!row) throw new Error('not found')
        const inc = data.notifyCount?.increment
        Object.assign(row, data, inc ? { notifyCount: row.notifyCount + inc } : {})
        return row
      }),
    },
  },
}))

vi.mock('@/agent/lib/notify-owner', () => ({
  notifyOwner: vi.fn(async (opts: { tier: number; title: string; actionUrl?: string | null }) => {
    notifyCalls.push({ tier: opts.tier, title: opts.title, actionUrl: opts.actionUrl })
    return deliveryFails
      ? { channels: ['ntfy_general'], statuses: { ntfy_general: 'error: unreachable' } }
      : { channels: ['ntfy_general'], statuses: { ntfy_general: 'sent' } }
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
    eventStore = {}
    eventsDown = false
    deliveryFails = false
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
    expect(first).toEqual({ received: 1, notified: 1, stored: 1 })

    const second = await handleAdsWebhook(payload)
    expect(second).toEqual({ received: 1, notified: 0, stored: 0 })
    expect(notifyCalls).toHaveLength(1)
  })

  it('ignores non-ad_account objects', async () => {
    const result = await handleAdsWebhook({ object: 'page', entry: [] })
    expect(result).toEqual({ received: 0, notified: 0, stored: 0 })
    expect(notifyCalls).toHaveLength(0)
  })

  it('stores the event and points the push AT it, not at an empty chat', async () => {
    await handleAdsWebhook(
      envelope([
        {
          field: 'ad_recommendations',
          value: { recommendation_hash: 'h1', ad_object_ids: ['77'], recommendation_type: 'BUDGET_LIMITED' },
        },
      ]),
    )
    const row = eventStore['rec:h1:77']
    expect(row).toBeTruthy()
    expect(row.recommendationType).toBe('BUDGET_LIMITED')
    expect(row.adObjectIds).toEqual(['77'])
    expect(notifyCalls[0]?.actionUrl).toBe(`/agent/growth?rec=${row.id}`)
  })

  it('a resolved recommendation never pushes again', async () => {
    const payload = envelope([
      {
        field: 'ad_recommendations',
        value: { recommendation_hash: 'h2', ad_object_ids: ['9'], recommendation_type: 'CTX_CREATION_PACKAGE' },
      },
    ])
    await handleAdsWebhook(payload)
    expect(notifyCalls).toHaveLength(1)

    // Owner dismisses it, Meta re-sends it after the KV window has passed.
    eventStore['rec:h2:9'].status = 'dismissed'
    kvStore = {}
    const again = await handleAdsWebhook(payload)
    expect(again.notified).toBe(0)
    expect(notifyCalls).toHaveLength(1)
  })

  it('an open recommendation re-pushes at most once a day', async () => {
    const payload = envelope([
      { field: 'ad_recommendations', value: { recommendation_hash: 'h3', ad_object_ids: ['5'] } },
    ])
    await handleAdsWebhook(payload)
    kvStore = {} // KV window expired; the DB layer is what must hold the line
    await handleAdsWebhook(payload)
    expect(notifyCalls).toHaveLength(1)

    eventStore['rec:h3:5'].lastNotifiedAt = new Date(Date.now() - 25 * 60 * 60 * 1000)
    kvStore = {}
    await handleAdsWebhook(payload)
    expect(notifyCalls).toHaveLength(2)
  })

  it('a handled DELIVERY-STATUS alert reopens when the ad changes again', async () => {
    // Object-keyed events repeat for every later change to the same ad: paused
    // today (handled), rejected tomorrow must still reach him.
    const payload = envelope([
      { field: 'field_changed', value: { object_id: '77', object_type: 'ad', changed_fields: ['effective_status'] } },
    ])
    await handleAdsWebhook(payload)
    expect(notifyCalls).toHaveLength(1)

    eventStore['status:ad:77'].status = 'actioned'
    kvStore = {}
    await handleAdsWebhook(payload)

    expect(notifyCalls).toHaveLength(2)
    expect(eventStore['status:ad:77'].status).toBe('new')
    expect(eventStore['status:ad:77'].detail).toBeNull()
  })

  it('a handled RECOMMENDATION stays closed — same key is the same news', async () => {
    const payload = envelope([
      { field: 'ad_recommendations', value: { recommendation_hash: 'h9', ad_object_ids: ['4'] } },
    ])
    await handleAdsWebhook(payload)
    eventStore['rec:h9:4'].status = 'actioned'
    kvStore = {}
    await handleAdsWebhook(payload)

    expect(notifyCalls).toHaveLength(1)
    expect(eventStore['rec:h9:4'].status).toBe('actioned')
  })

  it('a push that reached no channel is not counted as delivered', async () => {
    // Otherwise one transport outage silences an urgent alert for a whole day:
    // the failure would be indistinguishable from a successful delivery.
    deliveryFails = true
    const payload = envelope([
      { field: 'ad_recommendations', value: { recommendation_hash: 'h4', ad_object_ids: ['1'] } },
    ])
    const first = await handleAdsWebhook(payload)
    expect(first.notified).toBe(0)
    expect(eventStore['rec:h4:1'].lastNotifiedAt).toBeNull()

    deliveryFails = false
    kvStore = {}
    const second = await handleAdsWebhook(payload)
    expect(second.notified).toBe(1)
  })

  it('a second real change to the same ad within the KV window still lands', async () => {
    // Two genuine effective_status transitions carry a BYTE-IDENTICAL payload
    // (object_id + object_type + changed_fields) — only the entry timestamp tells
    // them apart. Keying the short window on the payload swallowed the rejection
    // that followed a pause an hour later.
    const change = {
      field: 'field_changed',
      value: { object_id: '12', object_type: 'ad', changed_fields: ['effective_status'] },
    }
    await handleAdsWebhook({ object: 'ad_account', entry: [{ id: 'act_1', time: 1782862117, changes: [change] }] })
    await handleAdsWebhook({ object: 'ad_account', entry: [{ id: 'act_1', time: 1782865717, changes: [change] }] })
    expect(notifyCalls).toHaveLength(2)
  })

  it("Meta's retry of the SAME entry is still suppressed", async () => {
    const payload = {
      object: 'ad_account',
      entry: [
        {
          id: 'act_1',
          time: 1782862117,
          changes: [{ field: 'field_changed', value: { object_id: '13', object_type: 'ad', changed_fields: ['effective_status'] } }],
        },
      ],
    }
    await handleAdsWebhook(payload)
    await handleAdsWebhook(payload)
    expect(notifyCalls).toHaveLength(1)
  })

  it('a failed push does not burn the retry window', async () => {
    // Meta retries the same entry; if the KV marker were stamped on attempt, that
    // retry would be discarded and the alert lost for six hours.
    deliveryFails = true
    const payload = {
      object: 'ad_account',
      entry: [
        {
          id: 'act_1',
          time: 1782870000,
          changes: [{ field: 'ad_recommendations', value: { recommendation_hash: 'h7', ad_object_ids: ['3'] } }],
        },
      ],
    }
    await handleAdsWebhook(payload)
    expect(notifyCalls).toHaveLength(1)

    deliveryFails = false
    const retry = await handleAdsWebhook(payload) // no manual kvStore reset
    expect(retry.notified).toBe(1)
  })

  it('DB down → the owner still gets the push (fail-open)', async () => {
    eventsDown = true
    const result = await handleAdsWebhook(
      envelope([
        { field: 'field_changed', value: { object_id: '55', object_type: 'campaign', changed_fields: ['effective_status'] } },
      ]),
    )
    expect(result).toEqual({ received: 1, notified: 1, stored: 0 })
    expect(notifyCalls[0]?.actionUrl).toBe('/agent/growth')
  })
})
