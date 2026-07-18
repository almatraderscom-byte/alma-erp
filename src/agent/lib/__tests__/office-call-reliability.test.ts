import { describe, expect, it } from 'vitest'
import {
  buildOfficeCallHealthSnapshot,
  decideOfficeCallPlacement,
  getOfficeCallRuntimePolicy,
  OFFICE_CALL_MEDIA_SECURITY_POSTURE,
  officeCallMaintenanceSchedule,
  officeCallReconnectBackoffMs,
  officeCallRolloutBucket,
} from '@/agent/lib/office-call-reliability'

const at = (value: string) => new Date(value)

describe('office call Phase 7 reliability policy', () => {
  it('clamps unsafe runtime configuration and keeps the emergency switch explicit', () => {
    const policy = getOfficeCallRuntimePolicy({
      OFFICE_CALLS_KILL_SWITCH: 'true',
      OFFICE_CALL_ROLLOUT_PERCENT: '999',
      OFFICE_CALL_MAX_DURATION_MINUTES: '1',
      OFFICE_CALL_RATE_CALLER_PER_MINUTE: '0',
      OFFICE_CALL_EVENT_RETENTION_DAYS: '9999',
    })
    expect(policy).toMatchObject({
      killSwitch: true,
      rolloutPercent: 100,
      maxCallDurationMs: 5 * 60_000,
      rateLimit: { callerPerMinute: 1 },
      retention: { eventsDays: 180 },
    })
  })

  it('uses stable rollout buckets and blocks kill-switch/rate-limit abuse', () => {
    const base = getOfficeCallRuntimePolicy({})
    expect(officeCallRolloutBucket('caller-a')).toBe(officeCallRolloutBucket('caller-a'))
    expect(decideOfficeCallPlacement({
      userId: 'caller-a', policy: { ...base, killSwitch: true },
      callerLastMinute: 0, callerLastTenMinutes: 0, pairLastTenMinutes: 0,
    })).toEqual({ ok: false, error: 'calling_disabled' })
    expect(decideOfficeCallPlacement({
      userId: 'caller-a', policy: base,
      callerLastMinute: base.rateLimit.callerPerMinute,
      callerLastTenMinutes: 0,
      pairLastTenMinutes: 0,
    })).toEqual({ ok: false, error: 'rate_limited', retryAfterSec: 60, limit: 'caller_per_minute' })
  })

  it('produces bounded exponential reconnect delays with deterministic jitter', () => {
    expect([1, 2, 3, 4, 5, 20].map((attempt) => officeCallReconnectBackoffMs(attempt, 0))).toEqual([
      1_000, 2_000, 4_000, 8_000, 8_000, 8_000,
    ])
    expect(officeCallReconnectBackoffMs(4, 1)).toBe(9_600)
  })

  it('correlates SLO latency and raises stuck/push/miss/failure/quality alerts', () => {
    const now = at('2026-07-18T00:00:00.000Z')
    const sessions = Array.from({ length: 11 }, (_, index) => ({
      id: `call-${index}`,
      state: index === 0 ? 'CONNECTED' : 'ENDED',
      terminalReason: index < 5 ? 'MISSED' : index < 8 ? 'FAILED' : 'COMPLETED',
      maxEndsAt: index === 0 ? at('2026-07-17T23:59:00.000Z') : at('2026-07-18T01:00:00.000Z'),
      updatedAt: at('2026-07-17T23:50:00.000Z'),
      createdAt: at('2026-07-17T23:40:00.000Z'),
    }))
    const events = [
      { callId: 'call-1', event: 'push.completed', source: 'server', platform: null, appBuild: null, success: true, latencyMs: null, metadata: null, occurredAt: at('2026-07-17T23:40:00.000Z') },
      { callId: 'call-1', event: 'client.ring_received', source: 'ios', platform: 'ios', appBuild: '1', success: null, latencyMs: null, metadata: null, occurredAt: at('2026-07-17T23:40:02.000Z') },
      { callId: 'call-1', event: 'client.answer_pressed', source: 'ios', platform: 'ios', appBuild: '1', success: null, latencyMs: null, metadata: null, occurredAt: at('2026-07-17T23:40:04.000Z') },
      { callId: 'call-1', event: 'client.peer_joined', source: 'ios', platform: 'ios', appBuild: '1', success: null, latencyMs: null, metadata: null, occurredAt: at('2026-07-17T23:40:06.500Z') },
      ...Array.from({ length: 5 }, (_, index) => ({ callId: `call-${index}`, event: 'push.completed', source: 'server', platform: null, appBuild: null, success: false, latencyMs: 200, metadata: null, occurredAt: now })),
      ...Array.from({ length: 5 }, (_, index) => ({ callId: `call-${index}`, event: 'client.quality_sample', source: 'android', platform: 'android', appBuild: '1', success: null, latencyMs: null, metadata: { rttMs: 900, packetLossPct: 25 }, occurredAt: now })),
      { callId: 'call-2', event: 'client.reconnect_started', source: 'web', platform: 'web', appBuild: '1', success: null, latencyMs: null, metadata: null, occurredAt: now },
    ]
    const health = buildOfficeCallHealthSnapshot({ sessions, events, now })
    expect(health.latencyMs).toMatchObject({ pushToRingP95: 2_000, answerToAudioP95: 2_500 })
    expect(health.alerts).toEqual(expect.arrayContaining([
      'stuck_active_sessions:1', 'push_rejection_spike', 'excessive_miss_rate',
      'call_failure_regression', 'media_quality_degraded',
    ]))
  })

  it('schedules bounded maintenance and explicitly forbids an E2EE claim', () => {
    expect(officeCallMaintenanceSchedule(at('2026-07-18T02:00:00.000Z'))).toEqual({ health: true, retention: true })
    expect(officeCallMaintenanceSchedule(at('2026-07-18T02:01:00.000Z'))).toEqual({ health: false, retention: false })
    expect(OFFICE_CALL_MEDIA_SECURITY_POSTURE).toMatchObject({
      transportEncrypted: true,
      applicationMediaEncryptionEnabled: false,
      endToEndEncryptedClaimAllowed: false,
    })
  })
})
