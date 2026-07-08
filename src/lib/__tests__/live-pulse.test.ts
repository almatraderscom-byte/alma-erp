import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the native App plugin + platform detector BEFORE importing the module under test.
const mockApp = vi.hoisted(() => ({ getInfo: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: mockApp }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import { syncLivePulse } from '@/lib/live-pulse'

// The LiveActivityBridge plugin is registered NATIVELY at runtime (no npm
// package) as window.Capacitor.Plugins.LiveActivityBridge — so we stub it on a
// fake window/Capacitor rather than mocking a module.
const mockBridge = {
  update: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
}

function installWindowWithBridge(bridge: unknown = mockBridge) {
  vi.stubGlobal('window', {
    Capacitor: { Plugins: { LiveActivityBridge: bridge } },
  })
}

/** Install a window whose Capacitor.Plugins does NOT include LiveActivityBridge. */
function installWindowWithoutBridge() {
  vi.stubGlobal('window', { Capacitor: { Plugins: {} } })
}

function buildOk(build = 8) {
  mockApp.getInfo.mockResolvedValue({ build: String(build) })
}

function fetchReturns(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }))
}

describe('syncLivePulse — native-only, build-gated, plugin-detected, fail-open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(8)
    installWindowWithBridge()
  })

  it('no-op off native — never reads build, plugin, or fetch', async () => {
    mockNative.isCapacitorNative.mockReturnValue(false)
    fetchReturns({ ordersToday: 3, statusLine: 'সর্বশেষ: শিপড' })
    await syncLivePulse()
    expect(mockApp.getInfo).not.toHaveBeenCalled()
    expect(mockBridge.update).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('no-op on an old binary (build < 8) — never touches the plugin', async () => {
    buildOk(7)
    fetchReturns({ ordersToday: 1, statusLine: 'সর্বশেষ: পেন্ডিং' })
    await syncLivePulse()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('no-op when getInfo build is unreadable', async () => {
    mockApp.getInfo.mockResolvedValue({ build: 'not-a-number' })
    await syncLivePulse()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('no-op when the plugin is absent — does NOT call update or fetch', async () => {
    installWindowWithoutBridge() // Capacitor.Plugins is present but no LiveActivityBridge
    fetchReturns({ ordersToday: 2, statusLine: 'সর্বশেষ: ডেলিভারড' })
    await syncLivePulse()
    expect(mockBridge.update).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('happy path — fetches the pulse and calls update with fetched values (hub counters included)', async () => {
    fetchReturns({ ordersToday: 5, statusLine: 'সর্বশেষ: শিপড', pendingApprovals: 2, openTasks: 3 })
    await syncLivePulse()

    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/assistant/live-pulse', {
      credentials: 'same-origin',
    })
    expect(mockBridge.update).toHaveBeenCalledTimes(1)
    expect(mockBridge.update).toHaveBeenCalledWith({
      title: 'ALMA ERP',
      ordersToday: 5,
      statusLine: 'সর্বশেষ: শিপড',
      pendingApprovals: 2,
      openTasks: 3,
    })
  })

  it('coerces missing/invalid fields to safe defaults', async () => {
    fetchReturns({})
    await syncLivePulse()
    expect(mockBridge.update).toHaveBeenCalledWith({
      title: 'ALMA ERP',
      ordersToday: 0,
      statusLine: '',
      pendingApprovals: 0,
      openTasks: 0,
    })
  })

  it('defaults hub counters to 0 when the API omits them (old server payload)', async () => {
    fetchReturns({ ordersToday: 4, statusLine: 'সর্বশেষ: কনফার্মড' })
    await syncLivePulse()
    expect(mockBridge.update).toHaveBeenCalledWith({
      title: 'ALMA ERP',
      ordersToday: 4,
      statusLine: 'সর্বশেষ: কনফার্মড',
      pendingApprovals: 0,
      openTasks: 0,
    })
  })

  it('coerces non-number hub counters to 0', async () => {
    fetchReturns({ ordersToday: 1, statusLine: 'সর্বশেষ: পেন্ডিং', pendingApprovals: '2', openTasks: null })
    await syncLivePulse()
    expect(mockBridge.update).toHaveBeenCalledWith({
      title: 'ALMA ERP',
      ordersToday: 1,
      statusLine: 'সর্বশেষ: পেন্ডিং',
      pendingApprovals: 0,
      openTasks: 0,
    })
  })

  it('swallows a fetch failure (resolves, never throws), no update', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(syncLivePulse()).resolves.toBeUndefined()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('no-op (returns) when fetch is non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    await expect(syncLivePulse()).resolves.toBeUndefined()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('swallows an update() rejection (resolves, never throws)', async () => {
    fetchReturns({ ordersToday: 1, statusLine: 'সর্বশেষ: পেন্ডিং' })
    mockBridge.update.mockRejectedValueOnce(new Error('activity failed'))
    await expect(syncLivePulse()).resolves.toBeUndefined()
    expect(mockBridge.update).toHaveBeenCalledTimes(1)
  })
})
