import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type {
  DirectYouTubeDeviceSelection,
  DirectYouTubeSelectedMediaState,
} from '@/agent/lib/live-browser/turn-lane'

const {
  runCommand,
  listOwnerDevices,
  bindDirectYouTubeOwnerTarget,
  bindDirectYouTubeSelectedMedia,
  bindDirectYouTubeSoleDevice,
  getDirectYouTubeDeviceSelection,
  getDirectYouTubeSelectedMedia,
  stageDirectYouTubeDeviceOptions,
  runDirectYouTubeOwnerFencedEffect,
  createPairingTicket,
} = vi.hoisted(() => ({
  runCommand: vi.fn(),
  listOwnerDevices: vi.fn(async () => [{
    id: 'dev-1', name: 'My Mac Chrome', online: true, lastSeenAt: new Date(),
  }]),
  getDirectYouTubeDeviceSelection: vi.fn(async (): Promise<DirectYouTubeDeviceSelection> => ({
    state: 'none',
  })),
  getDirectYouTubeSelectedMedia: vi.fn(async (): Promise<DirectYouTubeSelectedMediaState> => ({
    state: 'selected' as const,
    videoId: 'proofVID001',
    title: 'Coke Studio Bangla',
    fingerprint: '["a","","","","","Coke Studio Bangla","/watch?v=proofVID001"]',
  })),
  bindDirectYouTubeSelectedMedia: vi.fn(async () => true),
  bindDirectYouTubeOwnerTarget: vi.fn(async (input: {
    device: { deviceId: string; deviceName: string }
  }) => ({
    state: 'selected' as const,
    selectedOption: input.device.deviceName,
    ...input.device,
  })),
  bindDirectYouTubeSoleDevice: vi.fn(async (input: {
    device: { deviceId: string; deviceName: string }
  }) => ({
    state: 'selected' as const,
    selectedOption: input.device.deviceName,
    ...input.device,
  })),
  stageDirectYouTubeDeviceOptions: vi.fn(),
  runDirectYouTubeOwnerFencedEffect: vi.fn(
    async (input: { effect: () => Promise<unknown> }): Promise<
      { authorized: true; value: unknown } | { authorized: false }
    > => ({ authorized: true, value: await input.effect() }),
  ),
  createPairingTicket: vi.fn(),
}))

vi.mock('@/agent/lib/live-browser/companion', () => ({
  isLiveBrowserEnabled: vi.fn(async () => true),
  createPairingTicket,
  listOwnerDevices,
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

vi.mock('@/agent/lib/live-browser/turn-lane', () => ({
  bindDirectYouTubeOwnerTarget,
  bindDirectYouTubeSelectedMedia,
  bindDirectYouTubeSoleDevice,
  getDirectYouTubeDeviceSelection,
  getDirectYouTubeSelectedMedia,
  stageDirectYouTubeDeviceOptions,
  runDirectYouTubeOwnerFencedEffect,
}))

vi.mock('@/agent/lib/security/incident-response', () => ({
  isQuarantined: vi.fn(async () => false),
  triggerSecurityIncident: vi.fn(),
}))

import { LIVE_BROWSER_TOOLS } from '../live-browser-tools'

describe('live_browser_look semantic result', () => {
  beforeEach(() => {
    runCommand.mockReset()
    listOwnerDevices.mockReset().mockResolvedValue([{
      id: 'dev-1', name: 'My Mac Chrome', online: true, lastSeenAt: new Date(),
    }])
    getDirectYouTubeDeviceSelection.mockReset().mockResolvedValue({ state: 'none' })
    getDirectYouTubeSelectedMedia.mockReset().mockResolvedValue({
      state: 'selected',
      videoId: 'proofVID001',
      title: 'Coke Studio Bangla',
      fingerprint: '["a","","","","","Coke Studio Bangla","/watch?v=proofVID001"]',
    })
    bindDirectYouTubeSelectedMedia.mockReset().mockResolvedValue(true)
    bindDirectYouTubeOwnerTarget.mockReset().mockImplementation(async (input: {
      device: { deviceId: string; deviceName: string }
    }) => ({
      state: 'selected',
      selectedOption: input.device.deviceName,
      ...input.device,
    }))
    bindDirectYouTubeSoleDevice.mockReset().mockImplementation(async (input: {
      device: { deviceId: string; deviceName: string }
    }) => ({
      state: 'selected',
      selectedOption: input.device.deviceName,
      ...input.device,
    }))
    stageDirectYouTubeDeviceOptions.mockReset()
    runDirectYouTubeOwnerFencedEffect.mockReset().mockImplementation(
      async (input: { effect: () => Promise<unknown> }) => ({
        authorized: true as const,
        value: await input.effect(),
      }),
    )
    createPairingTicket.mockReset()
  })

  it.each([true, false])(
    'never lets the model mutate the global live-browser switch (direct=%s)',
    async (directBrowserTask) => {
      const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'set_live_browser')!
      const result = await tool.handler({
        enabled: true,
        directBrowserTask,
        conversationId: 'conv-1',
        directBrowserLaneToken: 'turn-current',
      })

      expect(result).toMatchObject({ success: false })
      expect(result.error).toContain('OWNER_CONTROL_REQUIRED')
    },
  )

  it('does not mint a direct pairing ticket after the owner fence becomes stale', async () => {
    runDirectYouTubeOwnerFencedEffect.mockResolvedValueOnce({ authorized: false })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_pair')!
    const result = await tool.handler({
      deviceName: 'My Mac Chrome',
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-old',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('OWNER_FENCE_BLOCKED')
    expect(createPairingTicket).not.toHaveBeenCalled()
  })

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

  it('enforces the exact owner-selected device card answer before LOOK', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-home', name: 'Home Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    getDirectYouTubeDeviceSelection.mockResolvedValueOnce({
      state: 'selected',
      selectedOption: 'Office Mac Chrome',
      deviceId: 'dev-office',
      deviceName: 'Office Mac Chrome',
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'both',
      screenshot: false,
      device: 'Home Mac Chrome',
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-1',
    })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('immutable card selection "Office Mac Chrome"')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('fails closed when a selected immutable id appears more than once', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-1', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-1', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    getDirectYouTubeDeviceSelection.mockResolvedValueOnce({
      state: 'selected',
      selectedOption: 'Office Mac Chrome · dev-1',
      deviceId: 'dev-1',
      deviceName: 'Office Mac Chrome',
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'both',
      screenshot: false,
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-1',
    })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('exactly one owner-paired Chrome')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('does not read or screenshot an off-host tab in the direct YouTube lane', async () => {
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-identity',
          data: { url: 'https://mail.google.com/mail/u/0/#inbox', documentId: 'gmail-doc' },
        }
      }
      throw new Error(`unexpected off-host command: ${action}`)
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'both',
      screenshot: true,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube',
      conversationId: 'conv-off-host',
      directBrowserLaneToken: 'turn-off-host',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_LOOK_HOST_BLOCKED')
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity'])
  })

  it.each([
    'https://studio.youtube.com/channel/example',
    'https://music.youtube.com/watch?v=proofVID001',
    'https://m.youtube.com/watch?v=proofVID001',
  ])('does not read or screenshot non-consumer YouTube subdomain %s', async (identityUrl) => {
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-identity-subdomain',
          data: { url: identityUrl, documentId: 'non-consumer-doc' },
        }
      }
      throw new Error(`unexpected non-consumer content command: ${action}`)
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'both',
      screenshot: true,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube',
      conversationId: 'conv-non-consumer-host',
      directBrowserLaneToken: 'turn-non-consumer-host',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_LOOK_HOST_BLOCKED')
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity'])
  })

  it.each(['https://youtube.com/', 'https://www.youtube.com/'])(
    'keeps canonical consumer host %s readable in the direct lane',
    async (identityUrl) => {
      runCommand.mockImplementation(async (_deviceId: string, action: string) => {
        if (action === 'get_identity') {
          return {
            ok: true,
            status: 'done',
            commandId: 'cmd-identity-consumer',
            data: { url: identityUrl, documentId: 'consumer-doc' },
          }
        }
        if (action === 'read_dom') {
          return {
            ok: true,
            status: 'done',
            commandId: 'cmd-dom-consumer',
            data: {
              url: identityUrl,
              documentId: 'consumer-doc',
              domObservationId: 'consumer-dom',
              elements: [],
            },
          }
        }
        throw new Error(`unexpected canonical-host command: ${action}`)
      })
      const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
      const result = await tool.handler({
        want: 'dom',
        screenshot: false,
        directBrowserTask: true,
        directBrowserOwnerRequest: 'Play Fix You on YouTube',
        conversationId: 'conv-consumer-host',
        directBrowserLaneToken: 'turn-consumer-host',
      })

      expect(result.success).toBe(true)
      expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity', 'read_dom'])
    },
  )

  it('returns no content from private YouTube consumer routes', async () => {
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-private-route',
          data: { url: 'https://www.youtube.com/feed/history', documentId: 'history-doc' },
        }
      }
      throw new Error(`unexpected private-route content command: ${action}`)
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'both',
      screenshot: true,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube',
      conversationId: 'conv-history',
      directBrowserLaneToken: 'turn-history',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_LOOK_SCOPE_BLOCKED')
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity'])
  })

  it('does not expose same-host private content when the tab changes after identity', async () => {
    const approvedUrl = 'https://www.youtube.com/'
    const privateUrl = 'https://www.youtube.com/feed/history'
    runCommand.mockImplementation(async (_deviceId: string, action: string, params?: Record<string, unknown>) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-race-identity',
          data: { url: approvedUrl, documentId: 'home-doc' },
        }
      }
      if (action === 'read_text') {
        expect(params).toMatchObject({
          requiredHost: 'youtube.com',
          expectedCurrentUrl: approvedUrl,
          expectedDocumentId: 'home-doc',
          requireForeground: true,
        })
        // Simulate an old/misbehaving Companion returning bytes from a
        // same-host navigation that happened after get_identity.
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-race-text',
          data: {
            url: privateUrl,
            documentId: 'history-doc',
            text: 'PRIVATE_WATCH_HISTORY_SENTINEL',
          },
        }
      }
      throw new Error(`unexpected identity-race command: ${action}`)
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'text',
      screenshot: false,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube',
      conversationId: 'conv-identity-race',
      directBrowserLaneToken: 'turn-identity-race',
    })

    expect(result.success).toBe(false)
    expect(result.error).toContain('LIVE_BROWSER_READ_FAILED')
    expect(JSON.stringify(result)).not.toContain('PRIVATE_WATCH_HISTORY_SENTINEL')
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity', 'read_text'])
  })

  it('reads only the exact owner-query YouTube results route', async () => {
    const resultsUrl = 'https://www.youtube.com/results?search_query=Fix+You'
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-results-identity',
          data: { url: resultsUrl, documentId: 'results-doc' },
        }
      }
      if (action === 'read_dom') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-results-dom',
          data: {
            url: resultsUrl,
            documentId: 'results-doc',
            domObservationId: 'results-observation',
            elements: [],
          },
        }
      }
      throw new Error(`unexpected results command: ${action}`)
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube',
      conversationId: 'conv-results',
      directBrowserLaneToken: 'turn-results',
    })

    expect(result.success).toBe(true)
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity', 'read_dom'])
  })

  it('stages exact server device options and refuses a model-only substring', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-home', name: 'Home Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    stageDirectYouTubeDeviceOptions.mockResolvedValueOnce({
      state: 'required',
      options: [
        { option: 'Home Mac Chrome', deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { option: 'Office Mac Chrome', deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'both',
      screenshot: false,
      device: 'Office',
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-1',
    })

    expect(result).toMatchObject({ success: false })
    expect((result.data as { requiredDeviceOptions?: unknown[] }).requiredDeviceOptions)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ option: 'Office Mac Chrome', deviceId: 'dev-office' }),
      ]))
    expect(result.error).toContain('card skip করতে পারবে না')
    expect(stageDirectYouTubeDeviceOptions).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      token: 'turn-1',
      devices: [
        { deviceId: 'dev-home', deviceName: 'Home Mac Chrome' },
        { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('uses the selected immutable id despite duplicate names and device reordering', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-z', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-a', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    getDirectYouTubeDeviceSelection.mockResolvedValueOnce({
      state: 'selected',
      selectedOption: 'Office Mac Chrome · dev-a',
      deviceId: 'dev-a',
      deviceName: 'Office Mac Chrome',
    })
    runCommand.mockResolvedValueOnce({
      ok: true,
      status: 'done',
      commandId: 'cmd-identity',
      data: { url: 'https://www.youtube.com/', documentId: 'youtube-home-document' },
    }).mockResolvedValueOnce({
      ok: true,
      status: 'done',
      commandId: 'cmd-dom',
      data: {
        url: 'https://www.youtube.com/',
        documentId: 'youtube-home-document',
        domObservationId: 'youtube-home-dom',
        elements: [],
      },
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      device: 'Office Mac Chrome · dev-a',
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-2',
    })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ deviceId: 'dev-a', device: 'Office Mac Chrome' })
    expect(runCommand).toHaveBeenCalledWith(
      'dev-a', 'read_dom', expect.objectContaining({
        requiredHost: 'youtube.com',
        expectedCurrentUrl: 'https://www.youtube.com/',
        expectedDocumentId: 'youtube-home-document',
      }), undefined,
      expect.objectContaining({ directBrowserLaneToken: 'turn-2' }),
      undefined,
    )
  })

  it('does not substitute the sole online device for an explicitly named offline device', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-home', name: 'Home Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: false, lastSeenAt: new Date() },
    ])
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      device: 'Office',
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-1',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('explicitly requested paired Chrome "Office Mac Chrome"')
    expect(result.error).toContain('silently ব্যবহার করছি না')
    expect(bindDirectYouTubeSoleDevice).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    { label: 'omits device', modelDevice: undefined },
    { label: 'claims Home', modelDevice: 'Home Mac Chrome' },
  ])('honors the server-owned Office target when the model $label', async ({ modelDevice }) => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-home', name: 'Home Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: false, lastSeenAt: new Date() },
    ])
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      ...(modelDevice ? { device: modelDevice } : {}),
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube using Office',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-owner-office',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('owner explicitly "Office Mac Chrome" target করেছেন')
    expect(result.error).toContain('অন্য online device silently ব্যবহার করছি না')
    expect(getDirectYouTubeDeviceSelection).not.toHaveBeenCalled()
    expect(bindDirectYouTubeOwnerTarget).not.toHaveBeenCalled()
    expect(bindDirectYouTubeSoleDevice).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('fails closed when the owner shorthand matches multiple paired device names', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-office-mac', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office-win', name: 'Office Windows Chrome', online: true, lastSeenAt: new Date() },
    ])
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube using Office',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-owner-office',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('device target unique নয়')
    expect(result.error).toContain('Office Mac Chrome, Office Windows Chrome')
    expect(getDirectYouTubeDeviceSelection).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('rejects a model device hint that conflicts with the unique online owner target', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-home', name: 'Home Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      device: 'Home Mac Chrome',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube using Office',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-owner-office',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('owner request exact "Office Mac Chrome" target করেছে')
    expect(result.error).toContain('model hint "Home Mac Chrome"')
    expect(getDirectYouTubeDeviceSelection).not.toHaveBeenCalled()
    expect(bindDirectYouTubeOwnerTarget).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    { title: 'Mac Miller', deviceName: 'Mac' },
    { title: 'MacBook Pro Theme', deviceName: 'MacBook' },
  ])('does not reinterpret the media title "$title" as a device target', async ({ title, deviceName }) => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-title-collision', name: deviceName, online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    stageDirectYouTubeDeviceOptions.mockResolvedValueOnce({
      state: 'required',
      options: [
        { option: deviceName, deviceId: 'dev-title-collision', deviceName },
        { option: 'Office Mac Chrome', deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
      ],
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      directBrowserTask: true,
      directBrowserOwnerRequest: `Play ${title} on YouTube`,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-title-collision',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('exact server-bound options')
    expect(bindDirectYouTubeOwnerTarget).not.toHaveBeenCalled()
    expect(stageDirectYouTubeDeviceOptions).toHaveBeenCalledOnce()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('binds and drives the unique online device explicitly named by the owner when the model omits it', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-home', name: 'Home Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-office', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    runCommand.mockResolvedValueOnce({
      ok: true,
      status: 'done',
      commandId: 'cmd-identity-office',
      data: { url: 'https://www.youtube.com/', documentId: 'youtube-office-document' },
    }).mockResolvedValueOnce({
      ok: true,
      status: 'done',
      commandId: 'cmd-dom-office',
      data: {
        url: 'https://www.youtube.com/',
        documentId: 'youtube-office-document',
        domObservationId: 'youtube-office-dom',
        elements: [],
      },
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Use Office Mac Chrome to play Fix You on YouTube',
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-owner-office',
    })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ deviceId: 'dev-office', device: 'Office Mac Chrome' })
    expect(bindDirectYouTubeOwnerTarget).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      token: 'turn-owner-office',
      device: { deviceId: 'dev-office', deviceName: 'Office Mac Chrome' },
    })
    expect(runCommand.mock.calls[0]?.[0]).toBe('dev-office')
  })

  it('rejects sole-device turnover after the first immutable binding', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-office', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    getDirectYouTubeDeviceSelection.mockResolvedValueOnce({
      state: 'selected',
      selectedOption: 'Home Mac Chrome',
      deviceId: 'dev-home',
      deviceName: 'Home Mac Chrome',
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-2',
    })

    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain('exactly one owner-paired Chrome')
    expect(bindDirectYouTubeSoleDevice).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'rename',
      devices: [{ id: 'dev-a', name: 'Renamed Chrome', online: true, lastSeenAt: new Date() }],
      error: 'rename/re-pair mismatch',
    },
    {
      label: 'repair',
      devices: [{ id: 'dev-new', name: 'Office Mac Chrome', online: true, lastSeenAt: new Date() }],
      error: 'exactly one owner-paired Chrome',
    },
  ])('rejects a selected device after $label', async ({ devices, error }) => {
    listOwnerDevices.mockResolvedValueOnce(devices)
    getDirectYouTubeDeviceSelection.mockResolvedValueOnce({
      state: 'selected',
      selectedOption: 'Office Mac Chrome',
      deviceId: 'dev-a',
      deviceName: 'Office Mac Chrome',
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'dom',
      screenshot: false,
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-2',
    })
    expect(result).toMatchObject({ success: false })
    expect(result.error).toContain(error)
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('surfaces deterministic media playback proof from the Companion', async () => {
    const media = {
      count: 1,
      playing: true,
      tabMuted: false,
      items: [{
        index: 0,
        mediaId: 'media-proof-1',
        kind: 'video',
        primary: true,
        playing: true,
        paused: false,
        ended: false,
        muted: false,
        volume: 1,
        currentTime: 12.4,
        duration: 245.1,
        readyState: 4,
        visible: true,
      }],
    }
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-identity',
          data: { url: 'https://www.youtube.com/watch?v=proofVID001', documentId: 'youtube-document-2' },
        }
      }
      if (action === 'read_text') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-text',
          data: {
            url: 'https://www.youtube.com/watch?v=proofVID001',
            documentId: 'youtube-document-1',
            title: 'Coke Studio Bangla - YouTube',
            youtube: {
              videoId: 'proofVID001',
              canonicalUrl: 'https://www.youtube.com/watch?v=proofVID001',
              title: 'Coke Studio Bangla',
            },
            text: 'Coke Studio Bangla now playing '.repeat(20),
            textLength: 620,
            truncated: false,
            media,
            scroll: { y: 0, viewport: 900, pageHeight: 900, atBottom: true },
          },
        }
      }
      if (action === 'read_dom') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-dom',
          data: {
            url: 'https://www.youtube.com/watch?v=proofVID001',
            documentId: 'youtube-document-1',
            domObservationId: 'dom-youtube-1',
            elements: [],
          },
        }
      }
      return { ok: true, status: 'done', commandId: `cmd-${action}` }
    })

    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')
    const result = await tool!.handler({ want: 'both', screenshot: false })

    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ deviceId: 'dev-1', domObservationId: 'dom-youtube-1' })
    expect((result.data as { mediaState?: unknown }).mediaState).toEqual(media)
    expect((result.data as { mediaObservation?: string }).mediaObservation).toContain('SINGLE_SAMPLE_ONLY')
    expect((result.data as { playbackProof?: string }).playbackProof).toBeUndefined()
  })

  it('verifies requested YouTube playback only when the media clock advances', async () => {
    let sample = 0
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-identity',
          data: { url: 'https://www.youtube.com/watch?v=proofVID001', documentId: 'youtube-document-2' },
        }
      }
      if (action === 'read_text') {
        sample++
        return {
          ok: true,
          status: 'done',
          commandId: `cmd-text-${sample}`,
          data: {
            url: 'https://www.youtube.com/watch?v=proofVID001',
            documentId: 'youtube-document-2',
            title: 'Coke Studio Bangla - YouTube',
            youtube: {
              videoId: 'proofVID001',
              canonicalUrl: 'https://www.youtube.com/watch?v=proofVID001',
              title: 'Coke Studio Bangla',
            },
            text: 'Coke Studio Bangla now playing '.repeat(20),
            textLength: 620,
            truncated: false,
            media: {
              count: 1,
              playing: true,
              adPlaying: false,
              tabMuted: false,
              tabActive: true,
              windowFocused: true,
              items: [{
                index: 0,
                mediaId: 'media-proof-2',
                kind: 'video',
                primary: true,
                playing: true,
                paused: false,
                ended: false,
                muted: false,
                volume: 1,
                currentTime: sample === 1 ? 20 : 20.9,
                readyState: 4,
                visible: true,
                viewportWidth: 900,
                viewportHeight: 506,
                viewportArea: 455400,
                exposedPointCount: 5,
                centerExposed: true,
                youtubeVideoId: 'proofVID001',
                youtubeTitle: 'Coke Studio Bangla',
              }],
            },
            scroll: { y: 0, viewport: 900, pageHeight: 900, atBottom: true },
          },
        }
      }
      if (action === 'read_dom') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-dom',
          data: {
            url: 'https://www.youtube.com/watch?v=proofVID001',
            documentId: 'youtube-document-2',
            domObservationId: 'dom-youtube-2',
            elements: [],
          },
        }
      }
      return { ok: true, status: 'done', commandId: `cmd-${action}` }
    })

    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')
    const result = await tool!.handler({
      want: 'both',
      screenshot: true,
      directBrowserTask: true,
      conversationId: 'conv-1',
      directBrowserLaneToken: 'turn-playback',
      expectedMedia: 'Coke Studio Bangla গানটা',
      expectedHost: 'youtube.com',
    })

    expect(result.success).toBe(true)
    expect((result.data as {
      playbackVerification?: { verified?: boolean; progressSeconds?: number; playbackObservedAt?: string }
    }).playbackVerification).toMatchObject({
      verified: true,
      progressSeconds: 0.9,
      playbackObservedAt: expect.any(String),
    })
    expect((result.data as { playbackObservedAt?: string }).playbackObservedAt)
      .toBe((result.data as { playbackVerification?: { playbackObservedAt?: string } }).playbackVerification?.playbackObservedAt)
    expect((result.data as { playbackProof?: string }).playbackProof).toContain('DOM_PROOF_VERIFIED')
    expect((result.data as { steps?: string[] }).steps).toContain('playback-verified:2-samples')
    expect(runCommand.mock.calls.filter((call) => call[1] === 'read_text')).toHaveLength(2)
    expect(runCommand.mock.calls.filter((call) => call[1] === 'read_text')
      .every((call) => (call[2] as { requireForeground?: boolean })?.requireForeground === true))
      .toBe(true)
    const actions = runCommand.mock.calls.map((call) => call[1])
    expect(actions.indexOf('screenshot')).toBeLessThan(actions.indexOf('wait'))
    expect(actions.indexOf('wait')).toBeLessThan(actions.lastIndexOf('read_text'))
    expect(bindDirectYouTubeSoleDevice).toHaveBeenCalledWith({
      conversationId: 'conv-1',
      token: 'turn-playback',
      device: { deviceId: 'dev-1', deviceName: 'My Mac Chrome' },
    })
  })

  it('cannot prove direct playback without a durable result identity selected before click', async () => {
    getDirectYouTubeSelectedMedia.mockResolvedValueOnce({ state: 'none' })
    let sample = 0
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'get_identity') {
        return {
          ok: true,
          status: 'done',
          commandId: 'cmd-identity',
          data: { url: 'https://www.youtube.com/watch?v=proofVID001', documentId: 'youtube-document-no-selection' },
        }
      }
      if (action !== 'read_text') {
        return { ok: true, status: 'done', commandId: `cmd-${action}` }
      }
      sample++
      return {
        ok: true,
        status: 'done',
        commandId: `cmd-text-${sample}`,
        data: {
          url: 'https://www.youtube.com/watch?v=proofVID001',
          documentId: 'youtube-document-no-selection',
          youtube: {
            videoId: 'proofVID001',
            canonicalUrl: 'https://www.youtube.com/watch?v=proofVID001',
            title: 'Coke Studio Bangla',
          },
          text: 'Coke Studio Bangla now playing '.repeat(20),
          media: {
            count: 1,
            playing: true,
            adPlaying: false,
            tabMuted: false,
            tabActive: true,
            windowFocused: true,
            items: [{
              index: 0,
              mediaId: 'media-no-selection',
              kind: 'video',
              primary: true,
              playing: true,
              paused: false,
              ended: false,
              muted: false,
              volume: 1,
              currentTime: sample === 1 ? 3 : 4,
              readyState: 4,
              visible: true,
              viewportWidth: 900,
              viewportHeight: 506,
              viewportArea: 455400,
              exposedPointCount: 5,
              centerExposed: true,
              youtubeVideoId: 'proofVID001',
              youtubeTitle: 'Coke Studio Bangla',
            }],
          },
          scroll: { y: 0, viewport: 900, pageHeight: 900, atBottom: true },
        },
      }
    })

    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'text',
      screenshot: false,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Coke Studio Bangla on YouTube',
      conversationId: 'conv-no-selection',
      directBrowserLaneToken: 'turn-no-selection',
      expectedMedia: 'Coke Studio Bangla',
      expectedHost: 'youtube.com',
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_LOOK_SCOPE_BLOCKED')
    expect(runCommand.mock.calls.map((call) => call[1])).toEqual(['get_identity'])
  })

  it('rejects a matching YouTube search title backed by an unrelated advancing miniplayer', async () => {
    let sample = 0
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action !== 'read_text') {
        return { ok: true, status: 'done', commandId: `cmd-${action}` }
      }
      sample++
      return {
        ok: true,
        status: 'done',
        commandId: `cmd-text-${sample}`,
        data: {
          url: 'https://www.youtube.com/results?search_query=coke+studio+bangla',
          documentId: 'youtube-search-document',
          title: 'Coke Studio Bangla - YouTube',
          text: 'Coke Studio Bangla search results',
          media: {
            count: 1,
            playing: true,
            adPlaying: false,
            tabMuted: false,
            tabActive: true,
            windowFocused: true,
            items: [{
              index: 0,
              mediaId: 'miniplayer-media',
              kind: 'video',
              primary: true,
              playing: true,
              paused: false,
              ended: false,
              muted: false,
              volume: 1,
              currentTime: sample === 1 ? 8 : 9,
              readyState: 4,
              visible: true,
              youtubeVideoId: 'wrongVID001',
              youtubeTitle: 'Unrelated miniplayer song',
            }],
          },
          scroll: { y: 0, viewport: 900, pageHeight: 900, atBottom: true },
        },
      }
    })

    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_look')!
    const result = await tool.handler({
      want: 'text',
      screenshot: false,
      expectedMedia: 'Coke Studio Bangla',
      expectedHost: 'youtube.com',
    })

    expect(result.success).toBe(true)
    expect((result.data as {
      playbackVerification?: { verified?: boolean; reasons?: string[] }
    }).playbackVerification).toMatchObject({
      verified: false,
      reasons: expect.arrayContaining([
        'youtube_final_url_or_page_identity_mismatch',
        'youtube_media_page_identity_mismatch',
      ]),
    })
    expect((result.data as { steps?: string[] }).steps).toContain('playback-failed:2-samples')
  })
})

describe('live_browser_act receipt transport', () => {
  beforeEach(() => {
    runCommand.mockReset()
    bindDirectYouTubeSelectedMedia.mockReset().mockResolvedValue(true)
    getDirectYouTubeSelectedMedia.mockReset().mockResolvedValue({
      state: 'selected',
      videoId: 'proofVID001',
      title: 'Coke Studio Bangla',
      fingerprint: '["a","","","","","Coke Studio Bangla","/watch?v=proofVID001"]',
    })
    listOwnerDevices.mockReset().mockResolvedValue([{
      id: 'dev-1', name: 'My Mac Chrome', online: true, lastSeenAt: new Date(),
    }])
  })

  const claim = {
    observationReceipt: 'receipt-bound-look-1',
    device: 'My Mac Chrome',
    deviceId: 'dev-1',
    currentUrl: 'https://example.com/current',
    documentId: 'document-current-1',
    domObservationId: 'dom-current-1',
    allowedRefs: ['e1', 'e-file'],
    refFingerprints: {
      e1: '["button","","button","","","Next",""]',
      'e-file': '["input","file","","","","",""]',
    },
  }

  it('ships URL/document/ref preconditions and removes selector/text fallbacks', async () => {
    runCommand.mockImplementation(async (_deviceId: string, action: string) => {
      if (action === 'click') return { ok: true, status: 'done', commandId: 'cmd-click', data: { clicked: 'Next' } }
      return { ok: false, status: 'failed', commandId: `cmd-${action}`, error: 'screenshot unavailable' }
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e1',
      selector: '#arbitrary-fallback',
      text: 'Next',
      device: claim.device,
      observationReceipt: claim.observationReceipt,
      browserObservationClaim: claim,
      conversationId: 'conv-1',
      turnId: 'turn-1',
    })
    expect(result.success).toBe(true)
    const click = runCommand.mock.calls.find((call) => call[1] === 'click')
    expect(click?.[2]).toMatchObject({
      ref: 'e1',
      observationPrecondition: {
        currentUrl: claim.currentUrl,
        documentId: claim.documentId,
        domObservationId: claim.domObservationId,
        allowedRefs: claim.allowedRefs,
        refFingerprints: claim.refFingerprints,
      },
    })
    expect(click?.[2]).not.toHaveProperty('selector')
    expect(click?.[2]).not.toHaveProperty('text')
    expect(click?.[0]).toBe('dev-1')
  })

  it('dispatches a click only once when its outcome is a page-script timeout', async () => {
    runCommand.mockResolvedValue({
      ok: false,
      status: 'failed',
      commandId: 'cmd-timeout',
      error: 'step_timeout: page script (15000ms)',
    })
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e1',
      device: claim.device,
      observationReceipt: claim.observationReceipt,
      browserObservationClaim: claim,
    })

    expect(result.success).toBe(false)
    expect(runCommand.mock.calls.filter((call) => call[1] === 'click')).toHaveLength(1)
    expect(runCommand.mock.calls.filter((call) => call[1] === 'wait')).toHaveLength(0)
  })

  it('dispatches to the claimed immutable device id despite duplicate names and reordering', async () => {
    listOwnerDevices.mockResolvedValueOnce([
      { id: 'dev-2', name: 'My Mac Chrome', online: true, lastSeenAt: new Date() },
      { id: 'dev-1', name: 'My Mac Chrome', online: true, lastSeenAt: new Date() },
    ])
    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'click'
        ? { ok: true, status: 'done', commandId: 'cmd-click', data: { clicked: 'Next' } }
        : { ok: false, status: 'failed', commandId: `cmd-${action}`, error: 'screenshot unavailable' }
    ))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e1',
      device: claim.device,
      observationReceipt: claim.observationReceipt,
      browserObservationClaim: claim,
    })
    expect(result.success).toBe(true)
    expect(runCommand.mock.calls.find((call) => call[1] === 'click')?.[0]).toBe('dev-1')
  })

  it.each([
    ['click', { ref: 'e1' }],
    ['type', { ref: 'e1', value: 'query' }],
    ['press', { key: 'Enter' }],
    ['close_tab', {}],
  ])('blocks direct-slice %s on a valid non-YouTube receipt', async (action, extra) => {
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action,
      ...extra,
      directBrowserTask: true,
      device: claim.device,
      observationReceipt: claim.observationReceipt,
      browserObservationClaim: claim,
    })
    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    ['press', { key: 'k' }],
    ['press', { key: 'm' }],
    ['press', { key: ' ' }],
    ['switch_tab', {}],
    ['close_tab', {}],
    ['select_option', { ref: 'e-search', option: 'Anything' }],
    ['pick_option', { ref: 'e-search', option: 'Anything' }],
    ['upload_file', { ref: 'e-search', url: 'https://cdn.example.com/file.png' }],
  ])('blocks direct-slice %s even on a valid search-only YouTube receipt', async (action, extra) => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=alma',
      allowedRefs: ['e-search'],
      refFingerprints: {
        'e-search': '["input","search","searchbox","Search","Search","",""]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action,
      ...extra,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Search YouTube for ALMA',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_ACTION_BLOCKED')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('allows hover only on an observed semantically safe YouTube target', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=alma',
      allowedRefs: ['e-watch'],
      refFingerprints: {
        'e-watch': '["a","","link","","","ALMA result","/watch?v=abcDEF_1234"]',
      },
    }
    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'hover'
        ? { ok: true, status: 'done', commandId: 'cmd-hover', data: { hovered: 'e-watch' } }
        : { ok: false, status: 'failed', commandId: `cmd-${action}`, error: 'screenshot unavailable' }
    ))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'hover',
      ref: 'e-watch',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Search YouTube for ALMA',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })

    expect(result.success).toBe(true)
    expect(runCommand.mock.calls.filter((call) => call[1] === 'hover')).toHaveLength(1)
  })

  it('blocks model-authored extra text from leaving through the YouTube search field', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=alma',
      allowedRefs: ['e-search'],
      refFingerprints: {
        'e-search': '["input","search","searchbox","Search","Search","",""]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'type',
      ref: 'e-search',
      value: 'ALMA sk_live_owner_secret',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Search YouTube for ALMA',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_TYPE_VALUE_BLOCKED')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('types only the server-parsed media query after removing the owner device clause', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=alma',
      allowedRefs: ['e-search'],
      refFingerprints: {
        'e-search': '["input","search","searchbox","Search","Search","",""]',
      },
    }
    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'type'
        ? { ok: true, status: 'done', commandId: 'cmd-type', data: { typed: true } }
        : { ok: false, status: 'failed', commandId: `cmd-${action}`, error: 'screenshot unavailable' }
    ))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'type',
      ref: 'e-search',
      value: 'ALMA',
      submit: true,
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Use My Mac Chrome to search ALMA on YouTube',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })

    expect(result.success).toBe(true)
    const typeCall = runCommand.mock.calls.find((call) => call[1] === 'type')
    expect(typeCall?.[2]).toMatchObject({ value: 'alma', ref: 'e-search' })
  })

  it('blocks a standalone Search click so stale page input cannot be submitted', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/',
      allowedRefs: ['e-search-button'],
      refFingerprints: {
        'e-search-button': ' ["button","","button","Search","Search","Search",""]'.trim(),
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-search-button',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube',
      conversationId: 'conv-stale-search',
      directBrowserLaneToken: 'turn-stale-search',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('DIRECT_BROWSER_TARGET_BLOCKED')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('allows an observed YouTube watch result but denies Subscribe in the direct slice', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=requested+song',
      allowedRefs: ['e-subscribe', 'e-clear-history', 'e-watch', 'e-watch-pp', 'e-external-play', 'e-redirect-play'],
      refFingerprints: {
        'e-subscribe': '["button","","button","","Subscribe","Subscribe",""]',
        'e-clear-history': '["button","","button","","Clear search history","Clear search history",""]',
        'e-watch': '["a","","","","","Requested song","/watch?v=abcDEF_1234"]',
        'e-watch-pp': '["a","","","","","Requested song","/watch?v=abcDEF_1234&pp=ygUOcmVxdWVzdGVkIHNvbmc%3D"]',
        'e-external-play': '["a","","link","","","Play","https://ads.example/play"]',
        'e-redirect-play': '["a","","link","","","Play","/redirect?q=https%3A%2F%2Fevil.example"]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const blocked = await tool.handler({
      action: 'click',
      ref: 'e-subscribe',
      directBrowserTask: true,
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })
    expect(blocked).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(runCommand).not.toHaveBeenCalled()

    const clearHistory = await tool.handler({
      action: 'click',
      ref: 'e-clear-history',
      directBrowserTask: true,
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })
    expect(clearHistory).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(runCommand).not.toHaveBeenCalled()

    for (const ref of ['e-external-play', 'e-redirect-play']) {
      const unsafeLink = await tool.handler({
        action: 'click',
        ref,
        directBrowserTask: true,
        device: youtubeClaim.device,
        observationReceipt: youtubeClaim.observationReceipt,
        browserObservationClaim: youtubeClaim,
      })
      expect(unsafeLink).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
      expect(runCommand).not.toHaveBeenCalled()
    }

    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'click'
        ? { ok: true, status: 'done', commandId: 'cmd-watch', data: { clicked: 'Requested song' } }
        : { ok: true, status: 'done', commandId: `cmd-${action}`, screenshot: null }
    ))
    const allowed = await tool.handler({
      action: 'click',
      ref: 'e-watch',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Requested song on YouTube',
      conversationId: 'conv-media',
      directBrowserLaneToken: 'turn-media',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })
    expect(allowed.success).toBe(true)
    expect(bindDirectYouTubeSelectedMedia).toHaveBeenCalledWith({
      conversationId: 'conv-media',
      token: 'turn-media',
      videoId: 'abcDEF_1234',
      title: 'Requested song',
      fingerprint: youtubeClaim.refFingerprints['e-watch'],
    })
    expect(runCommand.mock.calls.find((call) => call[1] === 'click')?.[0]).toBe('dev-1')

    const allowedSearchProvenance = await tool.handler({
      action: 'click',
      ref: 'e-watch-pp',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Requested song on YouTube',
      conversationId: 'conv-media',
      directBrowserLaneToken: 'turn-media',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    })
    expect(allowedSearchProvenance.success).toBe(true)
    expect(bindDirectYouTubeSelectedMedia).toHaveBeenLastCalledWith({
      conversationId: 'conv-media',
      token: 'turn-media',
      videoId: 'abcDEF_1234',
      title: 'Requested song',
      fingerprint: youtubeClaim.refFingerprints['e-watch-pp'],
    })
  })

  it('blocks a Fix You piano tutorial but binds a real-world official result before click', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=fix+you',
      allowedRefs: ['e-tutorial', 'e-official'],
      refFingerprints: {
        'e-tutorial': '["a","","link","","","Fix You piano tutorial","/watch?v=tutorial001"]',
        'e-official': '["a","","link","","","Coldplay - Fix You (Official Video)","/watch?v=official001"]',
      },
    }
    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'click'
        ? { ok: true, status: 'done', commandId: 'cmd-official', data: { clicked: true } }
        : { ok: true, status: 'done', commandId: `cmd-${action}`, screenshot: null }
    ))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const base = {
      action: 'click',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Fix You on YouTube using My Mac Chrome',
      conversationId: 'conv-fix-you',
      directBrowserLaneToken: 'turn-fix-you',
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    }

    const tutorial = await tool.handler({ ...base, ref: 'e-tutorial' })
    expect(tutorial).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(tutorial.error).toContain('MEDIA_TARGET_MISMATCH')
    expect(bindDirectYouTubeSelectedMedia).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()

    const official = await tool.handler({ ...base, ref: 'e-official' })
    expect(official.success).toBe(true)
    expect(bindDirectYouTubeSelectedMedia).toHaveBeenCalledWith({
      conversationId: 'conv-fix-you',
      token: 'turn-fix-you',
      videoId: 'official001',
      title: 'Coldplay - Fix You (Official Video)',
      fingerprint: youtubeClaim.refFingerprints['e-official'],
    })
    expect(runCommand.mock.calls.filter((call) => call[1] === 'click')).toHaveLength(1)
  })

  it('does not open/play a result when the owner authorized YouTube search only', async () => {
    const searchClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=alma',
      allowedRefs: ['e-search-result'],
      refFingerprints: {
        'e-search-result': '["a","","link","","","ALMA result","/watch?v=searchonly1"]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-search-result',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Search YouTube for ALMA',
      conversationId: 'conv-search-only',
      directBrowserLaneToken: 'turn-search-only',
      device: searchClaim.device,
      observationReceipt: searchClaim.observationReceipt,
      browserObservationClaim: searchClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('SEARCH_ONLY')
    expect(bindDirectYouTubeSelectedMedia).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('blocks playlist/mix result URLs while preserving exact canonical watch and Shorts links', async () => {
    const youtubeClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/results?search_query=requested+song',
      allowedRefs: ['e-mix', 'e-watch', 'e-shorts'],
      refFingerprints: {
        'e-mix': '["a","","link","","","Requested song mix","/watch?v=abcDEF_1234&list=RDabcDEF_1234&start_radio=1"]',
        'e-watch': '["a","","link","","","Requested song","/watch?v=abcDEF_1234"]',
        'e-shorts': '["a","","link","","","Requested short","/shorts/shortsID001"]',
      },
    }
    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'click'
        ? { ok: true, status: 'done', commandId: 'cmd-click', data: { clicked: true } }
        : { ok: false, status: 'failed', commandId: `cmd-${action}`, error: 'screenshot unavailable' }
    ))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const baseInput = {
      action: 'click',
      directBrowserTask: true,
      device: youtubeClaim.device,
      observationReceipt: youtubeClaim.observationReceipt,
      browserObservationClaim: youtubeClaim,
    }

    const mix = await tool.handler({
      ...baseInput,
      ref: 'e-mix',
      directBrowserOwnerRequest: 'Play Requested song on YouTube',
      conversationId: 'conv-mix',
      directBrowserLaneToken: 'turn-mix',
    })
    expect(mix).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(runCommand).not.toHaveBeenCalled()
    expect(bindDirectYouTubeSelectedMedia).not.toHaveBeenCalled()

    const watch = await tool.handler({
      ...baseInput,
      ref: 'e-watch',
      directBrowserOwnerRequest: 'Play Requested song on YouTube',
      conversationId: 'conv-watch',
      directBrowserLaneToken: 'turn-watch',
    })
    expect(watch.success).toBe(true)
    expect(bindDirectYouTubeSelectedMedia).toHaveBeenLastCalledWith(expect.objectContaining({
      videoId: 'abcDEF_1234',
      title: 'Requested song',
    }))
    expect(runCommand.mock.calls.filter((call) => call[1] === 'click')).toHaveLength(1)

    bindDirectYouTubeSelectedMedia.mockClear()
    runCommand.mockClear()
    const shorts = await tool.handler({
      ...baseInput,
      ref: 'e-shorts',
      directBrowserOwnerRequest: 'Play Requested short on YouTube',
      conversationId: 'conv-shorts',
      directBrowserLaneToken: 'turn-shorts',
    })
    expect(shorts.success).toBe(true)
    expect(bindDirectYouTubeSelectedMedia).toHaveBeenCalledWith(expect.objectContaining({
      videoId: 'shortsID001',
      title: 'Requested short',
    }))
    expect(runCommand.mock.calls.filter((call) => call[1] === 'click')).toHaveLength(1)
  })

  it('blocks a href-less Play control for a search-only owner request', async () => {
    const playbackClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/watch?v=proofVID001',
      allowedRefs: ['e-play'],
      refFingerprints: {
        'e-play': '["button","","button","","Play","Play",""]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-play',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Search YouTube for Coke Studio Bangla',
      conversationId: 'conv-search-control',
      directBrowserLaneToken: 'turn-search-control',
      device: playbackClaim.device,
      observationReceipt: playbackClaim.observationReceipt,
      browserObservationClaim: playbackClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('SEARCH_ONLY')
    expect(getDirectYouTubeSelectedMedia).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    'Mute',
    'Unmute',
    'Volume',
    'Fullscreen',
    'Theatre mode',
    'Captions',
    'Settings',
  ])('blocks href-less %s control for a search-only owner request', async (label) => {
    const playbackClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/watch?v=proofVID001',
      allowedRefs: ['e-player-control'],
      refFingerprints: {
        'e-player-control': JSON.stringify(['button', '', 'button', '', label, label, '']),
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-player-control',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Search YouTube for Coke Studio Bangla',
      conversationId: 'conv-search-player-control',
      directBrowserLaneToken: 'turn-search-player-control',
      device: playbackClaim.device,
      observationReceipt: playbackClaim.observationReceipt,
      browserObservationClaim: playbackClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('SEARCH_ONLY')
    expect(getDirectYouTubeSelectedMedia).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('blocks Next even when the receipt is on the exact selected video', async () => {
    const playbackClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/watch?v=proofVID001',
      allowedRefs: ['e-next'],
      refFingerprints: {
        'e-next': '["button","","button","","Next","Next",""]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-next',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Coke Studio Bangla on YouTube',
      conversationId: 'conv-next',
      directBrowserLaneToken: 'turn-next',
      device: playbackClaim.device,
      observationReceipt: playbackClaim.observationReceipt,
      browserObservationClaim: playbackClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('TRACK_SKIP_BLOCKED')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each([
    'Pause',
    'Mute',
    'Unmute',
    'Volume',
    'Fullscreen',
    'Theatre mode',
    'Captions',
    'Settings',
    'Play on TV',
    'Play all',
  ])('blocks unrequested href-less %s even for a playback request', async (label) => {
    const playbackClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/watch?v=proofVID001',
      allowedRefs: ['e-player-setting'],
      refFingerprints: {
        'e-player-setting': JSON.stringify(['button', '', 'button', '', label, label, '']),
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-player-setting',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Coke Studio Bangla on YouTube',
      conversationId: 'conv-player-setting',
      directBrowserLaneToken: 'turn-player-setting',
      device: playbackClaim.device,
      observationReceipt: playbackClaim.observationReceipt,
      browserObservationClaim: playbackClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('PLAYER_SETTING_BLOCKED')
    expect(getDirectYouTubeSelectedMedia).not.toHaveBeenCalled()
    expect(runCommand).not.toHaveBeenCalled()
  })

  it.each(['Play on TV', 'Play all'])(
    'blocks mixed player labels when one field says Play but another says %s',
    async (unsafeLabel) => {
      const playbackClaim = {
        ...claim,
        currentUrl: 'https://www.youtube.com/watch?v=proofVID001',
        allowedRefs: ['e-mixed-play'],
        refFingerprints: {
          'e-mixed-play': JSON.stringify([
            'button', '', 'button', 'Play', unsafeLabel, 'Play', '',
          ]),
        },
      }
      const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
      const result = await tool.handler({
        action: 'click',
        ref: 'e-mixed-play',
        directBrowserTask: true,
        directBrowserOwnerRequest: 'Play Coke Studio Bangla on YouTube',
        conversationId: 'conv-mixed-player-label',
        directBrowserLaneToken: 'turn-mixed-player-label',
        device: playbackClaim.device,
        observationReceipt: playbackClaim.observationReceipt,
        browserObservationClaim: playbackClaim,
      })

      expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
      expect(result.error).toContain('PLAYER_SETTING_BLOCKED')
      expect(getDirectYouTubeSelectedMedia).not.toHaveBeenCalled()
      expect(runCommand).not.toHaveBeenCalled()
    },
  )

  it('requires a Play control receipt URL to match the durable selected video id', async () => {
    const playbackClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/watch?v=wrongVID001',
      allowedRefs: ['e-play'],
      refFingerprints: {
        'e-play': '["button","","button","","Play","Play",""]',
      },
    }
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-play',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Coke Studio Bangla on YouTube',
      conversationId: 'conv-wrong-player',
      directBrowserLaneToken: 'turn-wrong-player',
      device: playbackClaim.device,
      observationReceipt: playbackClaim.observationReceipt,
      browserObservationClaim: playbackClaim,
    })

    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(result.error).toContain('PLAYBACK_CONTROL_BLOCKED')
    expect(getDirectYouTubeSelectedMedia).toHaveBeenCalledWith(
      'conv-wrong-player', 'turn-wrong-player',
    )
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('allows Play only on the receipt-bound selected video', async () => {
    const playbackClaim = {
      ...claim,
      currentUrl: 'https://www.youtube.com/watch?v=proofVID001',
      allowedRefs: ['e-play'],
      refFingerprints: {
        'e-play': '["button","","button","","Play","Play",""]',
      },
    }
    runCommand.mockImplementation(async (_deviceId: string, action: string) => (
      action === 'click'
        ? { ok: true, status: 'done', commandId: 'cmd-play', data: { clicked: 'Play' } }
        : { ok: true, status: 'done', commandId: `cmd-${action}`, screenshot: null }
    ))
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e-play',
      directBrowserTask: true,
      directBrowserOwnerRequest: 'Play Coke Studio Bangla on YouTube',
      conversationId: 'conv-right-player',
      directBrowserLaneToken: 'turn-right-player',
      device: playbackClaim.device,
      observationReceipt: playbackClaim.observationReceipt,
      browserObservationClaim: playbackClaim,
    })

    expect(result.success).toBe(true)
    expect(getDirectYouTubeSelectedMedia).toHaveBeenCalledWith(
      'conv-right-player', 'turn-right-player',
    )
    expect(runCommand.mock.calls.filter((call) => call[1] === 'click')).toHaveLength(1)
  })

  it('requires an observed ref for upload_file too', async () => {
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'upload_file',
      url: 'https://cdn.example.com/image.jpg',
      device: claim.device,
      observationReceipt: claim.observationReceipt,
      browserObservationClaim: claim,
    })
    expect(result).toMatchObject({ success: false, errorCode: 'workflow_blocked' })
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('keeps both server and resolved-ref final-submit checks', async () => {
    const tool = LIVE_BROWSER_TOOLS.find((item) => item.name === 'live_browser_act')!
    const result = await tool.handler({
      action: 'click',
      ref: 'e1',
      text: 'Send',
      device: claim.device,
      observationReceipt: claim.observationReceipt,
      browserObservationClaim: claim,
    })
    expect(result.success).toBe(false)
    expect(result.error).toContain('owner')
    expect(runCommand).not.toHaveBeenCalled()

    const source = readFileSync(new URL('../../../../extension/alma-companion/background.js', import.meta.url), 'utf8')
    const pageClick = source.slice(source.indexOf('async function pageClick'), source.indexOf('\nasync function pageType'))
    expect(pageClick).toContain('data-alma-ref')
    expect(pageClick).toContain('const elLabel')
    expect(pageClick).toContain('finalSubmitRe.test(elLabel)')
    expect(pageClick.indexOf('finalSubmitRe.test(elLabel)')).toBeLessThan(pageClick.indexOf('el.click()'))
  })
})
