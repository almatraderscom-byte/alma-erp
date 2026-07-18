import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  updateMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  findMany: vi.fn(),
  update: vi.fn(),
  signedUrl: vi.fn(),
  leaseRequired: vi.fn(),
  sendOwnerText: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentCameraSpeakJob: {
      create: mocks.create,
      updateMany: mocks.updateMany,
      findFirst: mocks.findFirst,
      findUnique: mocks.findUnique,
      findMany: mocks.findMany,
      update: mocks.update,
    },
  },
}))
vi.mock('@/agent/lib/google-tts', () => ({
  googleTtsConfigured: () => true,
  synthesizeBanglaMp3: vi.fn(),
}))
vi.mock('@/agent/lib/storage', () => ({
  agentStorageUpload: vi.fn(),
  agentStorageSignedUrl: mocks.signedUrl,
}))
vi.mock('@/agent/lib/camera-auth', () => ({
  cameraLeaseTokenRequired: mocks.leaseRequired,
}))
vi.mock('@/agent/lib/telegram-owner-notify', () => ({ sendOwnerText: mocks.sendOwnerText }))

import { ackSpeakJob, claimNextSpeakJob, sweepAndNotifySpeakJobs } from '../camera-say'

const queuedJob = {
  id: 'job-1',
  stream: 'entrance',
  text: 'প্যাকেট রেডি',
  audioPath: 'camera-say/job-1.mp3',
}

describe('camera speak delivery control plane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateMany.mockResolvedValue({ count: 0 })
    mocks.signedUrl.mockResolvedValue('https://signed.example/job-1.mp3')
    mocks.leaseRequired.mockResolvedValue(false)
  })

  it('atomically gives a raced job to only one bridge poll', async () => {
    mocks.findFirst.mockResolvedValue(queuedJob)
    let claimWon = false
    mocks.updateMany.mockImplementation(async (args: { where?: { id?: string } }) => {
      if (!args.where?.id) return { count: 0 }
      if (!claimWon) {
        claimWon = true
        return { count: 1 }
      }
      return { count: 0 }
    })

    const results = await Promise.all([claimNextSpeakJob(), claimNextSpeakJob()])
    const claims = results.filter((value) => value !== null)
    expect(claims).toHaveLength(1)
    expect(claims[0]).toMatchObject({
      id: 'job-1',
      stream: 'entrance',
      audioUrl: 'https://signed.example/job-1.mp3',
    })
    expect(claims[0]?.leaseToken).toMatch(/^[0-9a-f-]{36}$/)
    expect(claims[0]?.leaseExpiresAt).toMatch(/Z$/)
    expect(mocks.signedUrl).toHaveBeenCalledTimes(1)
  })

  it('runs stale expiry and crashed-lease recovery before every claim', async () => {
    mocks.findFirst.mockResolvedValue(null)
    await claimNextSpeakJob()
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: { in: ['queued', 'delivered'] } }),
      data: expect.objectContaining({ status: 'failed', error: 'expired' }),
    }))
    expect(mocks.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ status: 'delivered', OR: expect.any(Array) }),
      data: expect.objectContaining({ status: 'queued', error: 'lease_recovered' }),
    }))
  })

  it('accepts a deployed legacy ack until strict lease mode is enabled', async () => {
    mocks.findUnique.mockResolvedValue({
      status: 'delivered',
      leaseToken: 'new-lease',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    mocks.updateMany.mockResolvedValue({ count: 1 })
    await expect(ackSpeakJob('job-1', true)).resolves.toEqual({ accepted: true })

    mocks.leaseRequired.mockResolvedValue(true)
    await expect(ackSpeakJob('job-1', true)).resolves.toEqual({
      accepted: false,
      reason: 'lease_token_required',
    })
  })

  it('rejects a late ack from a different lease', async () => {
    mocks.findUnique.mockResolvedValue({
      status: 'delivered',
      leaseToken: 'current-lease',
      leaseExpiresAt: new Date(Date.now() + 60_000),
    })
    await expect(ackSpeakJob('job-1', true, undefined, 'old-lease')).resolves.toEqual({
      accepted: false,
      reason: 'lease_token_mismatch',
    })
  })

  it('retries failed owner notifications and describes success truthfully', async () => {
    mocks.findMany.mockResolvedValue([{
      id: 'job-1',
      status: 'done',
      error: null,
      text: 'প্যাকেট রেডি',
      stream: 'entrance',
    }])
    mocks.sendOwnerText.mockResolvedValue({ ok: false, error: 'telegram unavailable' })

    await sweepAndNotifySpeakJobs()

    expect(mocks.update).not.toHaveBeenCalled()
    expect(mocks.sendOwnerText).toHaveBeenCalledWith(expect.stringContaining('প্লেব্যাক কমান্ড গ্রহণ করেছে'))
    expect(mocks.sendOwnerText).toHaveBeenCalledWith(expect.stringContaining('মানুষ শুনেছে কি না'))
  })
})
