/**
 * ADS-2 phase B — the results Meta was already sending us.
 *
 * Every insights call returns an `actions` array with messages, link clicks,
 * leads, engagement, video views and purchases in it. This file used to read
 * `purchase` and drop the rest, so Boss could not ask his own agent how many
 * messages his ads produced — the answer arrived with every call and was thrown
 * away. And because purchases were the only lens, an OUTCOME_ENGAGEMENT campaign
 * was reported to him as "ROAS 0, money waste" on 2026-07-27.
 */
import { describe, expect, it } from 'vitest'
import { primaryResultFor, resultsFromActions } from '@/agent/lib/ads/insights'

const ACTIONS = [
  { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '14' },
  { action_type: 'link_click', value: '96' },
  { action_type: 'landing_page_view', value: '40' },
  { action_type: 'post_engagement', value: '210' },
  { action_type: 'video_view', value: '73' },
  { action_type: 'purchase', value: '2' },
  { action_type: 'some_future_thing_meta_adds', value: '5' },
]

describe('resultsFromActions', () => {
  it('reads every result type, not just purchases', () => {
    const r = resultsFromActions(ACTIONS)
    expect(r.messagingConversations).toBe(14)
    expect(r.linkClicks).toBe(96)
    expect(r.landingPageViews).toBe(40)
    expect(r.postEngagement).toBe(210)
    expect(r.videoViews).toBe(73)
    expect(r.purchases).toBe(2)
  })

  it('keeps an action type it has no name for instead of discarding it', () => {
    expect(resultsFromActions(ACTIONS).raw.some_future_thing_meta_adds).toBe(5)
  })

  it('matches the messaging type on a fragment, so a Graph version bump survives', () => {
    const v29 = [{ action_type: 'onsite_conversion.messaging_conversation_started_29d', value: '3' }]
    expect(resultsFromActions(v29).messagingConversations).toBe(3)
  })

  it('handles an empty or missing array', () => {
    expect(resultsFromActions(undefined).messagingConversations).toBe(0)
    expect(resultsFromActions([]).raw).toEqual({})
  })
})

describe('primaryResultFor — judge a campaign by what it is for', () => {
  const results = resultsFromActions(ACTIONS)

  it('an engagement campaign that produces messages is measured in messages', () => {
    // His real case: "New Engagement Campaign-July-17", OUTCOME_ENGAGEMENT.
    const p = primaryResultFor('OUTCOME_ENGAGEMENT', results, 10.35)
    expect(p.key).toBe('messagingConversations')
    expect(p.count).toBe(14)
    expect(p.costPer).toBeCloseTo(10.35 / 14, 4)
  })

  it('an engagement campaign with no messages falls back to engagement, not purchases', () => {
    const noMessages = resultsFromActions([{ action_type: 'post_engagement', value: '80' }])
    expect(primaryResultFor('OUTCOME_ENGAGEMENT', noMessages, 8).key).toBe('postEngagement')
  })

  it('a sales campaign is still measured in purchases', () => {
    expect(primaryResultFor('OUTCOME_SALES', results, 100).key).toBe('purchases')
  })

  it('leads, traffic and video objectives each get their own metric', () => {
    expect(primaryResultFor('OUTCOME_LEADS', results, 10).key).toBe('leads')
    expect(primaryResultFor('OUTCOME_TRAFFIC', results, 10).key).toBe('linkClicks')
    expect(primaryResultFor('VIDEO_VIEWS', results, 10).key).toBe('videoViews')
  })

  it('an unknown objective reports what the campaign actually produced', () => {
    expect(primaryResultFor('SOMETHING_NEW', results, 10).key).toBe('messagingConversations')
  })

  it('costPer stays 0 rather than dividing by zero', () => {
    const none = resultsFromActions([])
    expect(primaryResultFor('OUTCOME_SALES', none, 25).costPer).toBe(0)
  })
})

