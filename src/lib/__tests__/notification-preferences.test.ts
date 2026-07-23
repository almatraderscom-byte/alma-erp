import { describe, expect, it } from 'vitest'
import {
  DEFAULT_NOTIFICATION_PREFERENCE,
  notificationPreferenceAllows,
  withNotificationPreferenceDefaults,
} from '@/lib/notification-preferences'

describe('notificationPreferenceAllows', () => {
  it('keeps safe defaults enabled for users without a preference row', () => {
    expect(withNotificationPreferenceDefaults()).toEqual(DEFAULT_NOTIFICATION_PREFERENCE)
    expect(notificationPreferenceAllows(DEFAULT_NOTIFICATION_PREFERENCE, 'NORMAL', 'orders')).toBe(true)
  })

  it('master-off blocks routine alerts but criticalAlways still pierces it', () => {
    const pref = { ...DEFAULT_NOTIFICATION_PREFERENCE, enabled: false }
    expect(notificationPreferenceAllows(pref, 'HIGH', 'orders')).toBe(false)
    expect(notificationPreferenceAllows(pref, 'CRITICAL', 'orders')).toBe(true)
  })

  it('high-priority-only blocks low and normal without hiding high/critical', () => {
    const pref = { ...DEFAULT_NOTIFICATION_PREFERENCE, highPriorityOnly: true }
    expect(notificationPreferenceAllows(pref, 'LOW', 'orders')).toBe(false)
    expect(notificationPreferenceAllows(pref, 'NORMAL', 'orders')).toBe(false)
    expect(notificationPreferenceAllows(pref, 'HIGH', 'orders')).toBe(true)
    expect(notificationPreferenceAllows(pref, 'CRITICAL', 'orders')).toBe(true)
  })

  it('applies category controls after priority and master gates', () => {
    const pref = { ...DEFAULT_NOTIFICATION_PREFERENCE, agentCompletions: false }
    expect(notificationPreferenceAllows(pref, 'NORMAL', 'agentCompletions')).toBe(false)
    expect(notificationPreferenceAllows(pref, 'CRITICAL', 'agentCompletions')).toBe(true)
  })
})
