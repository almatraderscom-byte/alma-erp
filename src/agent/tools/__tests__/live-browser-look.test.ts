import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runCommand } = vi.hoisted(() => ({ runCommand: vi.fn() }))

vi.mock('@/agent/lib/live-browser/companion', () => ({
  isLiveBrowserEnabled: vi.fn(async () => true),
  setLiveBrowserEnabled: vi.fn(),
  createPairingTicket: vi.fn(),
  listOwnerDevices: vi.fn(async () => [{
    id: 'dev-1', name: 'My Mac Chrome', online: true, lastSeenAt: new Date(),
  }]),
  runCommand,
}))

vi.mock('@/agent/lib/storage', () => ({
  agentStorageUpload: vi.fn(),
  agentStorageSignedUrl: vi.fn(),
}))

vi.mock('@/agent/lib/live-browser/trust', () => ({
  getSiteTiers: vi.fn(async () => ({})),
  tierForHost: vi.fn(() => ({ tier: 'general' })),
  setSiteTier: vi.fn(),
  flagLockdownForUrl: vi.fn(),
  lockdownDomains: vi.fn(async () => []),
}))

import { LIVE_BROWSER_TOOLS } from '../live-browser-tools'

describe('live_browser_look semantic result', () => {
  beforeEach(() => runCommand.mockReset())

  it('fails once instead of claiming success when the online Companion cannot read the tab', async () => {
    runCommand.mockImplementation(async (_deviceId: string, action: string) => ({
      ok: false,
      status: 'failed',
      error: action === 'read_text' ? 'Cannot access contents of url about:blank' : 'Frame is showing error page',
      commandId: `cmd-${action}`,
    }))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')
    const result = await tool!.handler({ want: 'both', screenshot: false })

    expect(result.success).toBe(false)
    expect(result.error).toContain('Server Companion heartbeat পাচ্ছে')
    expect(result.error).toContain('extension OFF বলা নিষেধ')
    expect(runCommand.mock.calls.filter((call) => call[1] === 'read_text')).toHaveLength(1)
    expect(runCommand.mock.calls.filter((call) => call[1] === 'read_dom')).toHaveLength(1)
  })
})
