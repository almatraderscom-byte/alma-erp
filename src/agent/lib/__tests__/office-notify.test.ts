import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  findMany: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: { user: { findMany: mocks.findMany } },
}))
vi.mock('@/lib/trading-telegram-bot', () => ({ sendTelegramMessage: vi.fn() }))
vi.mock('@/agent/lib/notify-owner', () => ({ sendStaffNtfy: vi.fn() }))

import { pushStaffDevice } from '@/agent/lib/office-notify'

describe('office device notification access gate', () => {
  beforeEach(() => {
    mocks.findMany.mockReset()
    mocks.fetch.mockReset().mockResolvedValue({ ok: true, status: 200 })
    vi.stubGlobal('fetch', mocks.fetch)
    process.env.ONESIGNAL_APP_ID = 'app-id'
    process.env.ONESIGNAL_REST_API_KEY = 'api-key'
  })

  it('does not contact OneSignal when every requested user is inactive', async () => {
    mocks.findMany.mockResolvedValue([])

    await expect(pushStaffDevice(['offboarded-user'], 'Title', 'Body')).resolves.toEqual({
      ok: true,
      attempted: 0,
      status: null,
      reason: 'no_active_targets',
    })
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['offboarded-user'] }, active: true },
      select: { id: true },
    })
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('sends only to users still active at dispatch time', async () => {
    mocks.findMany.mockResolvedValue([{ id: 'active-user' }])

    await expect(pushStaffDevice(
      ['active-user', 'offboarded-user'],
      'Title',
      'Body',
    )).resolves.toMatchObject({ ok: true, attempted: 1 })

    const request = JSON.parse(mocks.fetch.mock.calls[0][1].body)
    expect(request.include_external_user_ids).toEqual(['active-user'])
  })
})
