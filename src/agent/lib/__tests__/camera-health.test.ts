import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ upsert: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
  prisma: { agentKvSetting: { upsert: mocks.upsert } },
}))

import {
  cameraHeartbeatFresh,
  cameraHeartbeatKey,
  recordCameraHeartbeat,
} from '../camera-health'

describe('camera health heartbeats', () => {
  beforeEach(() => mocks.upsert.mockReset())

  it('keeps bridge and listener-room health independent', () => {
    expect(cameraHeartbeatKey('bridge')).toBe('camera_health:bridge:last_seen_at')
    expect(cameraHeartbeatKey('listener', 'Entrance')).toBe('camera_health:listener:entrance:last_seen_at')
  })

  it('classifies timestamps using an explicit freshness window', () => {
    const now = Date.parse('2026-07-19T00:01:00.000Z')
    expect(cameraHeartbeatFresh('2026-07-19T00:00:31.000Z', now, 30_000)).toBe(true)
    expect(cameraHeartbeatFresh('2026-07-19T00:00:29.000Z', now, 30_000)).toBe(false)
    expect(cameraHeartbeatFresh('not-a-date', now, 30_000)).toBe(false)
  })

  it('records telemetry best-effort and never breaks media traffic', async () => {
    mocks.upsert.mockResolvedValueOnce({})
    const at = new Date('2026-07-19T00:00:00.000Z')
    await expect(recordCameraHeartbeat({ component: 'listener', room: 'boss', now: at, force: true }))
      .resolves.toMatchObject({ recorded: true, at: at.toISOString() })

    mocks.upsert.mockRejectedValueOnce(new Error('db unavailable'))
    await expect(recordCameraHeartbeat({
      component: 'listener',
      room: 'workroom-test-failure',
      now: at,
      force: true,
    })).resolves.toMatchObject({ recorded: false })
  })
})
