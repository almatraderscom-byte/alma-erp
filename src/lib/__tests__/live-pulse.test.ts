import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the native App plugin + platform detector BEFORE importing the module under test.
const mockApp = vi.hoisted(() => ({ getInfo: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: mockApp }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

// The LiveActivityBridge plugin is registered NATIVELY at runtime (no npm
// package) as window.Capacitor.Plugins.LiveActivityBridge — so we stub it on a
// fake window/Capacitor rather than mocking a module.
const mockBridge = {
  update: vi.fn().mockResolvedValue(undefined),
  markOffline: vi.fn().mockResolvedValue(undefined),
  end: vi.fn().mockResolvedValue(undefined),
}

/** A minimal in-memory localStorage — the alert dedupe memory lives here. */
function makeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  }
}

function installWindowWithBridge(bridge: unknown = mockBridge) {
  vi.stubGlobal('window', {
    Capacitor: { Plugins: { LiveActivityBridge: bridge } },
    localStorage: makeStorage(),
  })
}

/** Install a window whose Capacitor.Plugins does NOT include LiveActivityBridge. */
function installWindowWithoutBridge() {
  vi.stubGlobal('window', { Capacitor: { Plugins: {} }, localStorage: makeStorage() })
}

function buildOk(build = 8) {
  mockApp.getInfo.mockResolvedValue({ build: String(build) })
}

function fetchReturns(payload: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => payload }))
}

/** A v3 snapshot as the server returns it. */
function snapshot(over: Record<string, unknown> = {}) {
  return {
    mode: 'approval',
    headline: 'আপনার অনুমোদনেই পরের ধাপ',
    subtitle: 'লেজার এন্ট্রি — অপেক্ষায়',
    pendingTaskCount: 3,
    approvalCount: 2,
    runningOrderCount: 4,
    items: [],
    lastUpdatedAt: '2026-07-16T10:00:00Z',
    staleAfter: '2026-07-16T10:15:00Z',
    alertKey: 'approval:a1:created',
    ordersToday: 5,
    statusLine: 'সর্বশেষ: পেন্ডিং',
    pendingApprovals: 2,
    openTasks: 3,
    ...over,
  }
}

/**
 * Import a FRESH copy of the module. syncLivePulse keeps a module-level
 * "already reconciled once this launch" flag, so each test that cares about
 * alerting must start from a clean launch.
 */
async function freshModule() {
  vi.resetModules()
  return import('@/lib/live-pulse')
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
    fetchReturns(snapshot())
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()
    expect(mockApp.getInfo).not.toHaveBeenCalled()
    expect(mockBridge.update).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('no-op on an old binary (build < 8) — never touches the plugin', async () => {
    buildOk(7)
    fetchReturns(snapshot())
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('no-op when getInfo build is unreadable', async () => {
    mockApp.getInfo.mockResolvedValue({ build: 'not-a-number' })
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('no-op when the plugin is absent — does NOT call update or fetch', async () => {
    installWindowWithoutBridge()
    fetchReturns(snapshot())
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()
    expect(mockBridge.update).not.toHaveBeenCalled()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('happy path — sends the canonical snapshot JSON plus the legacy scalars', async () => {
    fetchReturns(snapshot())
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/assistant/live-pulse', {
      credentials: 'same-origin',
    })
    expect(mockBridge.update).toHaveBeenCalledTimes(1)
    const arg = mockBridge.update.mock.calls[0][0]
    expect(arg.title).toBe('ALMA ERP')
    expect(arg.ordersToday).toBe(5)
    expect(arg.statusLine).toBe('সর্বশেষ: পেন্ডিং')
    expect(arg.pendingApprovals).toBe(2)
    expect(arg.openTasks).toBe(3)

    const cs = JSON.parse(arg.snapshotJson)
    expect(cs.mode).toBe('approval')
    expect(cs.runningOrderCount).toBe(4)
    expect(typeof cs.updatedAtEpoch).toBe('number')
  })

  it('accepts a pre-v3 server payload (no mode) without rendering an empty panel', async () => {
    fetchReturns({ ordersToday: 4, statusLine: 'সর্বশেষ: কনফার্মড' })
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()

    const arg = mockBridge.update.mock.calls[0][0]
    expect(arg.ordersToday).toBe(4)
    const cs = JSON.parse(arg.snapshotJson)
    expect(cs.mode).toBe('overview')
    expect(cs.statusLine).toBe('সর্বশেষ: কনফার্মড')
  })

  it('coerces missing/invalid fields to safe defaults', async () => {
    fetchReturns({})
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()
    const arg = mockBridge.update.mock.calls[0][0]
    expect(arg.ordersToday).toBe(0)
    expect(arg.pendingApprovals).toBe(0)
    expect(arg.openTasks).toBe(0)
  })

  it('marks the panel offline when the network is unreachable — never leaves a stale count looking current', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { syncLivePulse } = await freshModule()
    await expect(syncLivePulse()).resolves.toBeUndefined()
    expect(mockBridge.markOffline).toHaveBeenCalledTimes(1)
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('no-op (returns) when fetch is non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    const { syncLivePulse } = await freshModule()
    await expect(syncLivePulse()).resolves.toBeUndefined()
    expect(mockBridge.update).not.toHaveBeenCalled()
  })

  it('swallows an update() rejection (resolves, never throws)', async () => {
    fetchReturns(snapshot())
    mockBridge.update.mockRejectedValueOnce(new Error('activity failed'))
    const { syncLivePulse } = await freshModule()
    await expect(syncLivePulse()).resolves.toBeUndefined()
    expect(mockBridge.update).toHaveBeenCalledTimes(1)
  })
})

describe('sound policy — an event may chime at most once (spec §11.5, §14)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(8)
    installWindowWithBridge()
  })

  it('the FIRST sync of a launch is reconciliation — always silent', async () => {
    fetchReturns(snapshot())
    const { syncLivePulse } = await freshModule()
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[0][0].alert).toBe(false)
  })

  it('a genuinely new approval that appears while running DOES chime, once', async () => {
    const { syncLivePulse } = await freshModule()

    // Launch reconciliation with nothing pending.
    fetchReturns(snapshot({ mode: 'overview', alertKey: undefined }))
    await syncLivePulse()

    // A new approval arrives.
    fetchReturns(snapshot({ alertKey: 'approval:NEW:created' }))
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[1][0].alert).toBe(true)
    expect(mockBridge.update.mock.calls[1][0].alertKind).toBe('approval')

    // Polling the SAME approval again must stay silent.
    fetchReturns(snapshot({ alertKey: 'approval:NEW:created' }))
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[2][0].alert).toBe(false)
  })

  it('an urgent alert asks for the urgent sound', async () => {
    const { syncLivePulse } = await freshModule()
    fetchReturns(snapshot({ mode: 'overview', alertKey: undefined }))
    await syncLivePulse()

    fetchReturns(snapshot({ mode: 'urgent', alertKey: 'urgent:stock:X:created' }))
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[1][0].alertKind).toBe('urgent')
  })

  it('an approval seen during reconciliation never chimes later either', async () => {
    const { syncLivePulse } = await freshModule()

    // The approval already existed at launch (push very likely already alerted).
    fetchReturns(snapshot({ alertKey: 'approval:OLD:created' }))
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[0][0].alert).toBe(false)

    // Still pending on the next poll — must remain silent.
    fetchReturns(snapshot({ alertKey: 'approval:OLD:created' }))
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[1][0].alert).toBe(false)
  })

  it('ordinary count/progress changes never chime', async () => {
    const { syncLivePulse } = await freshModule()
    fetchReturns(snapshot({ mode: 'overview', alertKey: undefined }))
    await syncLivePulse()

    fetchReturns(snapshot({ mode: 'orders', runningOrderCount: 99, alertKey: undefined }))
    await syncLivePulse()
    expect(mockBridge.update.mock.calls[1][0].alert).toBe(false)
  })
})

describe('showPulseSuccess — silent, with the authoritative state underneath', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(8)
    installWindowWithBridge()
  })

  it('sends success mode without an alert', async () => {
    fetchReturns(snapshot())
    const { showPulseSuccess } = await freshModule()
    await showPulseSuccess({
      title: 'অনুমোদন হয়েছে',
      detail: 'কাজ আবার এগোচ্ছে',
      completedAt: '2026-07-16T10:05:00Z',
    })
    const arg = mockBridge.update.mock.calls[0][0]
    expect(arg.alert).toBe(false)
    const cs = JSON.parse(arg.snapshotJson)
    expect(cs.mode).toBe('success')
    expect(cs.successTitle).toBe('অনুমোদন হয়েছে')
    // Falls back to real server state, not an outdated local cache (spec §6.6).
    expect(cs.runningOrderCount).toBe(4)
  })
})
