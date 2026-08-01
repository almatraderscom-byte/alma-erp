/**
 * W4 — the drive_mac_app tool layer. The classifier itself is proven in
 * ui-policy.test.ts; these tests prove the TOOL obeys it: RED never reaches
 * the queue or the card table, AMBER becomes a card and not a command, GREEN
 * enqueues immediately. All I/O is mocked — this is the decision layer only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const createCard = vi.fn()
const enqueueCommand = vi.fn()
const awaitResult = vi.fn()
const requireOnlineMac = vi.fn()
const uiEnabled = vi.fn()
const listDevices = vi.fn()

vi.mock('@/lib/prisma', () => ({
  prisma: { agentPendingAction: { create: (...args: unknown[]) => createCard(...args) } },
}))
vi.mock('@/agent/lib/mac-agent/bus', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/agent/lib/mac-agent/bus')>()
  return {
    ...real,
    enqueueCommand: (...args: unknown[]) => enqueueCommand(...args),
    awaitResult: (...args: unknown[]) => awaitResult(...args),
    isMacUiDrivingEnabled: (...args: unknown[]) => uiEnabled(...args),
    listDevices: (...args: unknown[]) => listDevices(...args),
  }
})
vi.mock('../mac-tools', async (importOriginal) => {
  const real = await importOriginal<typeof import('../mac-tools')>()
  return {
    ...real,
    requireOnlineMac: (...args: unknown[]) => requireOnlineMac(...args),
  }
})

import { MAC_UI_TOOLS } from '../mac-ui-tools'
import { isToolAllowedForOwnerTurn } from '@/agent/lib/turn-authorization'
import { assemblePack } from '../state-router'

const look = MAC_UI_TOOLS.find((t) => t.name === 'look_mac_app')!
const drive = MAC_UI_TOOLS.find((t) => t.name === 'drive_mac_app')!
const listApps = MAC_UI_TOOLS.find((t) => t.name === 'list_mac_apps')!

beforeEach(() => {
  vi.clearAllMocks()
  requireOnlineMac.mockResolvedValue({ ok: true, deviceId: 'dev-1', deviceName: 'MacBook Air' })
  createCard.mockResolvedValue({ id: 'card-1' })
  enqueueCommand.mockResolvedValue({ id: 'cmd-1' })
  awaitResult.mockResolvedValue({ status: 'done', stdout: 'TREE', stderr: '', timedOut: false })
  uiEnabled.mockResolvedValue(true)
  listDevices.mockResolvedValue([{ id: 'dev-1', name: 'MacBook Air', online: true, pairedAt: new Date() }])
})

describe('drive_mac_app — multi-Mac ambiguity', () => {
  it('refuses honestly when more than one Mac is online instead of guessing', async () => {
    listDevices.mockResolvedValue([
      { id: 'dev-1', name: 'MacBook Air', online: true, pairedAt: new Date() },
      { id: 'dev-2', name: 'Mac mini', online: true, pairedAt: new Date() },
    ])
    const r = await look.handler({ action: 'tree', app: 'claude' })
    expect(r.success).toBe(false)
    expect((r.data as { code?: string })?.code).toBe('multiple_macs_online')
    expect(enqueueCommand).not.toHaveBeenCalled()
    expect(createCard).not.toHaveBeenCalled()
  })
})

describe('drive_mac_app — capability gate', () => {
  it('refuses honestly while the daemon has no ui driver (KV switch off)', async () => {
    uiEnabled.mockResolvedValue(false)
    const r = await look.handler({ action: 'tree', app: 'claude' })
    expect(r.success).toBe(false)
    expect((r.data as { code?: string })?.code).toBe('ui_driving_disabled')
    expect(enqueueCommand).not.toHaveBeenCalled()
    expect(createCard).not.toHaveBeenCalled()
  })

  it('policy RED still wins over the gate — the reason names the rule, not the switch', async () => {
    uiEnabled.mockResolvedValue(false)
    const r = await drive.handler({ action: 'click', app: 'com.apple.safari', elementLabel: 'Send' })
    expect((r.data as { code?: string })?.code).toBe('app_not_allowlisted')
  })
})

describe('drive_mac_app — RED', () => {
  it('refuses a non-allowlisted app without touching the queue or the card table', async () => {
    const r = await drive.handler({ action: 'click', app: 'com.apple.safari', elementLabel: 'Send' })
    expect(r.success).toBe(false)
    expect((r.data as { code?: string })?.code).toBe('app_not_allowlisted')
    expect(enqueueCommand).not.toHaveBeenCalled()
    expect(createCard).not.toHaveBeenCalled()
  })

  it('refuses a destructive label inside an allowed app — no card to approve', async () => {
    const r = await drive.handler({ action: 'click', app: 'claude', elementLabel: 'Delete chat' })
    expect(r.success).toBe(false)
    expect((r.data as { code?: string })?.code).toBe('destructive_label')
    expect(createCard).not.toHaveBeenCalled()
  })

  it('refuses a click with no element label — the label IS the safety check', async () => {
    const r = await drive.handler({ action: 'click', app: 'claude' })
    expect(r.success).toBe(false)
    expect((r.data as { code?: string })?.code).toBe('label_required')
  })
})

describe('drive_mac_app — AMBER', () => {
  it('turns a type into a card carrying the app, the element and the LITERAL text', async () => {
    const r = await drive.handler({ action: 'type', app: 'chatgpt', elementLabel: 'Message', text: 'dam koto?' })
    expect(r.success).toBe(true)
    expect((r.data as { policy?: string })?.policy).toBe('amber')
    expect(enqueueCommand).not.toHaveBeenCalled()
    const row = createCard.mock.calls[0][0] as { data: { type: string; summary: string; payload: Record<string, unknown> } }
    expect(row.data.type).toBe('mac_ui_action')
    expect(row.data.summary).toContain('ChatGPT')
    expect(row.data.summary).toContain('Message')
    expect(row.data.summary).toContain('dam koto?')
    expect(row.data.payload.uiAction).toBe('ui_type')
    // "chatgpt" resolves to the SHIPPING app's bundle id (PR #681).
    expect(row.data.payload.bundleId).toBe('com.openai.codex')
  })

  it('requires focusedLabel before Enter becomes a card', async () => {
    const blind = await drive.handler({ action: 'key', app: 'claude', key: 'enter' })
    expect(blind.success).toBe(false)
    expect((blind.data as { code?: string })?.code).toBe('focus_required')

    const sighted = await drive.handler({ action: 'key', app: 'claude', key: 'enter', focusedLabel: 'Prompt' })
    expect(sighted.success).toBe(true)
    expect((sighted.data as { policy?: string })?.policy).toBe('amber')
  })
})

describe('drive_mac_app — GREEN', () => {
  it('runs a tree read immediately and returns the output', async () => {
    const r = await look.handler({ action: 'tree', app: 'claude' })
    expect(r.success).toBe(true)
    expect((r.data as { output?: string })?.output).toBe('TREE')
    const q = enqueueCommand.mock.calls[0][0] as { action: string; policyLevel: string; params: Record<string, unknown> }
    expect(q.action).toBe('ui_tree')
    expect(q.policyLevel).toBe('green')
    expect(q.params.bundleId).toBe('com.anthropic.claudefordesktop')
    expect(createCard).not.toHaveBeenCalled()
  })

  it('still refuses when the Mac is offline', async () => {
    requireOnlineMac.mockResolvedValue({ ok: false, error: 'offline' })
    const r = await look.handler({ action: 'tree', app: 'claude' })
    expect(r.success).toBe(false)
    expect(enqueueCommand).not.toHaveBeenCalled()
  })
})

describe('the read/act split — the reason the two tools exist', () => {
  it('look_mac_app survives an explicit "কিছু কোরো না" turn; drive_mac_app does not', () => {
    const noAction = { allowMutations: false, reason: 'explicit_no_action' as const }
    expect(isToolAllowedForOwnerTurn('look_mac_app', noAction)).toBe(true)
    expect(isToolAllowedForOwnerTurn('list_mac_apps', noAction)).toBe(true)
    expect(isToolAllowedForOwnerTurn('drive_mac_app', noAction)).toBe(false)
  })

  it('drive_mac_app refuses read verbs — the read tool owns them', async () => {
    const r = await drive.handler({ action: 'tree', app: 'claude' })
    expect(r.success).toBe(false)
    expect((r.data as { code?: string })?.code).toBe('wrong_tool')
  })

  it('the app tools survive the 24-tool router cap on a mixed mac turn', () => {
    const { names } = assemblePack(['mac', 'research', 'erp'])
    expect(names).toContain('look_mac_app')
    expect(names).toContain('drive_mac_app')
  })
})

describe('list_mac_apps', () => {
  it('names exactly the two allowlisted apps (ids may vary per install)', async () => {
    const r = await listApps.handler({})
    const apps = (r.data as { apps: Array<{ name: string; bundleId: string }> }).apps
    expect(new Set(apps.map((a) => a.name))).toEqual(new Set(['ChatGPT', 'Claude']))
    for (const a of apps) expect(a.bundleId).toMatch(/^com\./)
  })
})
