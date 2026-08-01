/**
 * W4 — the bus backstop for ui_* verbs. Whatever caller makes the mistake, a
 * RED UI action must never reach the queue, and an amber one never without an
 * approval id. Mirrors the run_command backstop that already exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
const findFirst = vi.fn()
const updateMany = vi.fn()
const findMany = vi.fn()
const kvFindUnique = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: {
    macAgentCommand: {
      create: (...args: unknown[]) => create(...args),
      findFirst: (...args: unknown[]) => findFirst(...args),
      updateMany: (...args: unknown[]) => updateMany(...args),
      findMany: (...args: unknown[]) => findMany(...args),
    },
    agentKvSetting: { findUnique: (...args: unknown[]) => kvFindUnique(...args) },
  },
}))

import { claimNextCommand, enqueueCommand } from '../bus'

beforeEach(() => {
  vi.clearAllMocks()
  create.mockResolvedValue({ id: 'row-1' })
  findMany.mockResolvedValue([])
  updateMany.mockResolvedValue({ count: 1 })
  kvFindUnique.mockResolvedValue({ value: 'true' })
})

describe('enqueueCommand — ui_* backstop', () => {
  it('throws on a RED ui action and never creates the row', async () => {
    await expect(
      enqueueCommand({
        deviceId: 'dev-1',
        action: 'ui_click',
        params: { bundleId: 'com.apple.keychainaccess', elementLabel: 'OK' },
      }),
    ).rejects.toThrow(/red_ui_action_rejected/)
    expect(create).not.toHaveBeenCalled()
  })

  it('throws on an amber ui action with no approval id', async () => {
    await expect(
      enqueueCommand({
        deviceId: 'dev-1',
        action: 'ui_type',
        params: { bundleId: 'com.anthropic.claudefordesktop', elementLabel: 'Prompt', text: 'hi' },
      }),
    ).rejects.toThrow('amber_ui_action_requires_approval')
    expect(create).not.toHaveBeenCalled()
  })

  it('enqueues an approved amber ui action', async () => {
    await enqueueCommand({
      deviceId: 'dev-1',
      action: 'ui_type',
      params: { bundleId: 'com.anthropic.claudefordesktop', elementLabel: 'Prompt', text: 'hi' },
      policyLevel: 'amber',
      approvedBy: 'card-1',
    })
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('enqueues a green read with no approval', async () => {
    await enqueueCommand({
      deviceId: 'dev-1',
      action: 'ui_tree',
      params: { bundleId: 'com.openai.chat' },
    })
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('claimNextCommand — the UI kill switch stops QUEUED work too', () => {
  it('cancels a queued ui_* command loudly when the switch is off, and moves on', async () => {
    kvFindUnique.mockResolvedValue({ value: 'false' })
    findFirst
      .mockResolvedValueOnce({ id: 'ui-1', action: 'ui_click', params: {}, sessionKey: null })
      .mockResolvedValueOnce({ id: 'sh-1', action: 'run_command', params: {}, sessionKey: null })
    const claimed = await claimNextCommand('dev-1')
    // The ui row was failed, not delivered; the shell row was delivered normally.
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ui-1', status: 'queued' },
        data: expect.objectContaining({ status: 'cancelled' }),
      }),
    )
    expect(claimed?.id).toBe('sh-1')
  })

  it('delivers ui_* normally while the switch is on', async () => {
    findFirst.mockResolvedValueOnce({ id: 'ui-2', action: 'ui_tree', params: {}, sessionKey: null })
    const claimed = await claimNextCommand('dev-1')
    expect(claimed?.id).toBe('ui-2')
  })

  it('an UNREADABLE switch delivers nothing but destroys nothing — a DB blip is not the owner saying stop', async () => {
    kvFindUnique.mockRejectedValue(new Error('db down'))
    findFirst.mockResolvedValueOnce({ id: 'ui-3', action: 'ui_click', params: {}, sessionKey: null })
    const claimed = await claimNextCommand('dev-1')
    expect(claimed).toBeNull()
    // No cancel, no delivery — the row stays queued for the next poll.
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'cancelled' }) }),
    )
    expect(updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'delivered' }) }),
    )
  })
})
