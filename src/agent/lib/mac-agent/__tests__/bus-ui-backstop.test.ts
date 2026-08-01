/**
 * W4 — the bus backstop for ui_* verbs. Whatever caller makes the mistake, a
 * RED UI action must never reach the queue, and an amber one never without an
 * approval id. Mirrors the run_command backstop that already exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const create = vi.fn()
vi.mock('@/lib/prisma', () => ({
  prisma: { macAgentCommand: { create: (...args: unknown[]) => create(...args) } },
}))

import { enqueueCommand } from '../bus'

beforeEach(() => {
  vi.clearAllMocks()
  create.mockResolvedValue({ id: 'row-1' })
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
