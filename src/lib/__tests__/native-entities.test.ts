import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockApp = vi.hoisted(() => ({ getInfo: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: mockApp }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import { syncNativeEntities } from '@/lib/native-entities'

const mockBridge = { setEntities: vi.fn().mockResolvedValue({ saved: true }) }

function installWindowWithBridge(bridge: unknown = mockBridge) {
  vi.stubGlobal('window', { Capacitor: { Plugins: { EntityCacheBridge: bridge } } })
}
function installWindowWithoutBridge() {
  vi.stubGlobal('window', { Capacitor: { Plugins: {} } })
}
function buildOk(build = 11) {
  mockApp.getInfo.mockResolvedValue({ build: String(build) })
}
function fetchReturns(payload: unknown, ok = true) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok, json: async () => payload }))
}

const ORDERS = [{ id: 'O1', title: 'Rahim — Kurti', status: 'PENDING' }]

describe('syncNativeEntities — native-only, build-gated (≥11), plugin-detected, fail-open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(11)
    installWindowWithBridge()
    fetchReturns({ orders: ORDERS, products: [] })
  })

  it('happy path — fetches feed and pushes orders/products to the bridge', async () => {
    await syncNativeEntities()
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/assistant/native-entities', {
      credentials: 'same-origin',
    })
    expect(mockBridge.setEntities).toHaveBeenCalledWith({ orders: ORDERS, products: [] })
  })

  it('no-op off native — never reads build, plugin, or fetch', async () => {
    mockNative.isCapacitorNative.mockReturnValue(false)
    await syncNativeEntities()
    expect(mockApp.getInfo).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockBridge.setEntities).not.toHaveBeenCalled()
  })

  it('no-op on an old binary (build < 11)', async () => {
    buildOk(10)
    await syncNativeEntities()
    expect(mockBridge.setEntities).not.toHaveBeenCalled()
  })

  it('no-op when the plugin is absent — does not fetch', async () => {
    installWindowWithoutBridge()
    await syncNativeEntities()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockBridge.setEntities).not.toHaveBeenCalled()
  })

  it('coerces missing arrays to empty and still calls setEntities', async () => {
    fetchReturns({})
    await syncNativeEntities()
    expect(mockBridge.setEntities).toHaveBeenCalledWith({ orders: [], products: [] })
  })

  it('no-op when fetch is non-OK', async () => {
    fetchReturns({}, false)
    await syncNativeEntities()
    expect(mockBridge.setEntities).not.toHaveBeenCalled()
  })

  it('swallows a fetch rejection (resolves, never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(syncNativeEntities()).resolves.toBeUndefined()
    expect(mockBridge.setEntities).not.toHaveBeenCalled()
  })

  it('swallows a setEntities rejection (resolves, never throws)', async () => {
    mockBridge.setEntities.mockRejectedValueOnce(new Error('no app group'))
    await expect(syncNativeEntities()).resolves.toBeUndefined()
    expect(mockBridge.setEntities).toHaveBeenCalledTimes(1)
  })
})
