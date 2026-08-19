import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const mocks = vi.hoisted(() => ({
  getJwt: vi.fn(),
  resolveOwnerUserIds: vi.fn(),
  isSystemOwner: vi.fn(),
  isMacAgentEnabled: vi.fn(),
  authenticateDevice: vi.fn(),
  enqueueCommand: vi.fn(),
  awaitResult: vi.fn(),
  setMacAgentEnabled: vi.fn(),
  isKnownViewUid: vi.fn(),
  registerViewUid: vi.fn(),
  grantControl: vi.fn(),
  revokeControl: vi.fn(),
  listControlAudit: vi.fn(),
  deviceFindFirst: vi.fn(),
  deviceFindMany: vi.fn(),
  deviceCreate: vi.fn(),
  deviceUpdateMany: vi.fn(),
  commandFindFirst: vi.fn(),
  commandFindMany: vi.fn(),
  commandUpdateMany: vi.fn(),
  sessionEventFindFirst: vi.fn(),
}))

vi.mock('@/agent/lib/guards', () => ({ requireAgentEnabled: () => null }))
vi.mock('@/agent/lib/native-owner-push', () => ({
  resolveOwnerUserIds: mocks.resolveOwnerUserIds,
}))
vi.mock('@/lib/api-guards', () => ({ getJwt: mocks.getJwt }))
vi.mock('@/lib/roles', () => ({ isSystemOwner: mocks.isSystemOwner }))
vi.mock('@/agent/lib/mac-agent/bus', () => ({
  authenticateDevice: mocks.authenticateDevice,
  enqueueCommand: mocks.enqueueCommand,
  awaitResult: mocks.awaitResult,
  isMacAgentEnabled: mocks.isMacAgentEnabled,
  setMacAgentEnabled: mocks.setMacAgentEnabled,
}))
vi.mock('@/agent/lib/mac-agent/remote-control', () => ({
  CONTROL_TTL_SEC: 120,
  ControlHeldByAnother: class ControlHeldByAnother extends Error {},
  isKnownViewUid: mocks.isKnownViewUid,
  registerViewUid: mocks.registerViewUid,
  grantControl: mocks.grantControl,
  revokeControl: mocks.revokeControl,
  listControlAudit: mocks.listControlAudit,
}))
vi.mock('@/lib/prisma', () => ({
  prisma: {
    macAgentDevice: {
      findFirst: mocks.deviceFindFirst,
      findMany: mocks.deviceFindMany,
      create: mocks.deviceCreate,
      updateMany: mocks.deviceUpdateMany,
    },
    macAgentCommand: {
      findFirst: mocks.commandFindFirst,
      findMany: mocks.commandFindMany,
      updateMany: mocks.commandUpdateMany,
    },
    macAgentSessionEvent: { findFirst: mocks.sessionEventFindFirst },
  },
}))
vi.mock('agora-token', () => ({
  RtcRole: { PUBLISHER: 1, SUBSCRIBER: 2 },
  RtcTokenBuilder: {
    buildTokenWithUid: vi.fn(() => 'rtc-token'),
    buildTokenWithUidAndPrivilege: vi.fn(() => 'rtc-control-token'),
  },
}))

import { POST as screenVideoToken } from '../screen-video-token/route'
import {
  GET as screenControlAudit,
  POST as screenControlToken,
} from '../screen-control-token/route'
import { POST as stream } from '../stream/route'
import { POST as sessionReply } from '../session-reply/route'
import { GET as status, POST as statusAction } from '../status/route'

function post(path: string, body: Record<string, unknown>) {
  return new NextRequest(`https://alma.test${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

function get(path: string) {
  return new NextRequest(`https://alma.test${path}`)
}

describe('Mac owner endpoint boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('AGORA_APP_ID', 'agora-app')
    vi.stubEnv('AGORA_APP_CERTIFICATE', 'agora-secret')
    mocks.getJwt.mockResolvedValue({ sub: 'owner-1', role: 'SUPER_ADMIN' })
    mocks.resolveOwnerUserIds.mockResolvedValue(['owner-1'])
    mocks.isSystemOwner.mockReturnValue(true)
    mocks.isMacAgentEnabled.mockResolvedValue(true)
    mocks.deviceFindFirst.mockResolvedValue(null)
    mocks.deviceFindMany.mockResolvedValue([])
    mocks.deviceCreate.mockResolvedValue({ id: 'mac-created' })
    mocks.deviceUpdateMany.mockResolvedValue({ count: 1 })
    mocks.commandFindMany.mockResolvedValue([])
    mocks.commandUpdateMany.mockResolvedValue({ count: 0 })
    mocks.sessionEventFindFirst.mockResolvedValue(null)
    mocks.enqueueCommand.mockResolvedValue({ id: 'command-1' })
    mocks.awaitResult.mockResolvedValue({
      id: 'command-1',
      status: 'done',
      exitCode: 0,
      stdout: '',
      stderr: '',
      error: null,
      timedOut: false,
    })
  })

  it('rejects a role-valid user who is not in the resolved owner membership', async () => {
    mocks.resolveOwnerUserIds.mockResolvedValue([])

    const responses = await Promise.all([
      screenVideoToken(post('/api/assistant/mac-agent/screen-video-token', {})),
      screenControlToken(post('/api/assistant/mac-agent/screen-control-token', {})),
      stream(post('/api/assistant/mac-agent/stream', { on: true })),
      sessionReply(post('/api/assistant/mac-agent/session-reply', { sessionId: 's-1', text: 'hi' })),
      status(get('/api/assistant/mac-agent/status')),
    ])

    expect(responses.map((response) => response.status)).toEqual([403, 403, 403, 403, 403])
    expect(mocks.deviceFindFirst).not.toHaveBeenCalled()
    expect(mocks.deviceFindMany).not.toHaveBeenCalled()
    expect(mocks.commandUpdateMany).not.toHaveBeenCalled()
  })

  it('scopes screen token and control-audit device lookups to the active owner', async () => {
    await screenVideoToken(post('/api/assistant/mac-agent/screen-video-token', {
      deviceId: 'requested-mac',
    }))
    await screenControlAudit(get(
      '/api/assistant/mac-agent/screen-control-token?deviceId=requested-mac',
    ))

    expect(mocks.deviceFindFirst).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { id: 'requested-mac', ownerUserId: 'owner-1', revoked: false },
    }))
    expect(mocks.deviceFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'requested-mac', ownerUserId: 'owner-1', revoked: false },
    }))
  })

  it('scopes stream selection and queued-start cancellation to owned devices', async () => {
    await stream(post('/api/assistant/mac-agent/stream', { on: true }))
    expect(mocks.deviceFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ ownerUserId: 'owner-1', revoked: false }),
    }))

    mocks.deviceFindMany.mockResolvedValue([{
      id: 'owned-mac',
      pairedAt: new Date(),
      lastSeenAt: new Date(),
    }])
    await stream(post('/api/assistant/mac-agent/stream', { on: false }))
    expect(mocks.deviceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerUserId: 'owner-1', revoked: false },
    }))
    expect(mocks.commandUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ deviceId: { in: ['owned-mac'] } }),
    }))
  })

  it('looks up a session only inside the owner device set', async () => {
    mocks.deviceFindMany.mockResolvedValue([{
      id: 'owned-mac',
      pairedAt: new Date(),
      lastSeenAt: new Date(),
    }])
    mocks.sessionEventFindFirst.mockResolvedValue({ deviceId: 'owned-mac' })

    const response = await sessionReply(post('/api/assistant/mac-agent/session-reply', {
      sessionId: 'session-1',
      text: 'continue',
    }))

    expect(response.status).toBe(200)
    expect(mocks.deviceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerUserId: 'owner-1', revoked: false },
    }))
    expect(mocks.sessionEventFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { sessionId: 'session-1', deviceId: { in: ['owned-mac'] } },
    }))
    expect(mocks.enqueueCommand).toHaveBeenCalledWith(expect.objectContaining({
      deviceId: 'owned-mac',
    }))
  })

  it('scopes status devices, history, pairing, stop, and unpair to owner.sub', async () => {
    await status(get('/api/assistant/mac-agent/status'))
    expect(mocks.deviceFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { ownerUserId: 'owner-1', revoked: false },
    }))
    expect(mocks.commandFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { device: { ownerUserId: 'owner-1' } },
    }))

    await statusAction(post('/api/assistant/mac-agent/status', {
      action: 'pair_code',
      deviceName: 'Office Mac',
    }))
    expect(mocks.deviceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ ownerUserId: 'owner-1', name: 'Office Mac' }),
    }))

    await statusAction(post('/api/assistant/mac-agent/status', {
      action: 'stop',
      deviceId: 'owned-mac',
    }))
    expect(mocks.commandUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        deviceId: 'owned-mac',
        device: { ownerUserId: 'owner-1' },
      }),
    }))

    await statusAction(post('/api/assistant/mac-agent/status', {
      action: 'unpair',
      deviceId: 'owned-mac',
    }))
    expect(mocks.deviceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'owned-mac', ownerUserId: 'owner-1', revoked: false },
    }))
  })
})
