import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Prisma } from '@prisma/client'

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    smsLog: {
      findUnique: mocks.findUnique,
      findFirst: mocks.findFirst,
      create: mocks.create,
    },
  },
}))

vi.mock('@/lib/sms/phone', () => ({ normalizeSmsPhone: () => '8801700000000' }))
vi.mock('@/lib/sms/provider', () => ({
  smsProviderConfigured: () => true,
  sendSmsViaProvider: vi.fn(),
  fetchSmsReport: vi.fn(),
}))
vi.mock('@/lib/sms/settings', () => ({
  smsEnabledForBusiness: async () => true,
  isSmsTypeActive: async () => true,
}))

import { queueSms } from '@/lib/sms/queue'

const input = {
  businessId: 'ALMA_LIFESTYLE',
  phone: '01700000000',
  type: 'PENALTY_APPEAL_REVIEWED' as const,
  message: 'Appeal result',
  cooldownMinutes: 0,
  contentId: 'penalty-appeal-reviewed:waiver-1',
}

describe('queueSms durable content idempotency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.findFirst.mockResolvedValue(null)
  })

  it('returns the existing SMS before cooldown matching when content id already exists', async () => {
    mocks.findUnique.mockResolvedValue({ id: 'sms-existing' })

    await expect(queueSms(input)).resolves.toEqual({
      ok: true,
      duplicate: true,
      id: 'sms-existing',
    })
    expect(mocks.create).not.toHaveBeenCalled()
  })

  it('recovers a concurrent unique-key race as a duplicate', async () => {
    mocks.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'sms-race-winner' })
    mocks.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError(
      'Unique constraint failed',
      { code: 'P2002', clientVersion: 'test' },
    ))

    await expect(queueSms(input)).resolves.toEqual({
      ok: true,
      duplicate: true,
      id: 'sms-race-winner',
    })
  })
})
