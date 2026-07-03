import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the native plugins + platform detector BEFORE importing the module under test.
const mockLocalNotifications = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  schedule: vi.fn().mockResolvedValue(undefined),
  cancel: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: mockLocalNotifications }))

const mockApp = vi.hoisted(() => ({ getInfo: vi.fn() }))
vi.mock('@capacitor/app', () => ({ App: mockApp }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import { syncLocalReminders } from '@/lib/local-reminders'

// Minimal in-memory localStorage.
function installLocalStorage() {
  const store = new Map<string, string>()
  const ls = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  }
  vi.stubGlobal('localStorage', ls)
  return store
}

const SCHEDULED_IDS_KEY = 'alma_local_reminder_ids'

function granted() {
  mockLocalNotifications.checkPermissions.mockResolvedValue({ display: 'granted' })
}

function buildOk(build = 5) {
  mockApp.getInfo.mockResolvedValue({ build: String(build) })
}

function fetchReturns(reminders: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, json: async () => ({ reminders }) }),
  )
}

const HOUR = 60 * 60 * 1000

describe('syncLocalReminders — native-only, build-gated, fail-open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
    installLocalStorage()
    mockNative.isCapacitorNative.mockReturnValue(true)
    buildOk(5)
    granted()
  })

  it('no-op off native — never touches the plugin', async () => {
    mockNative.isCapacitorNative.mockReturnValue(false)
    await syncLocalReminders()
    expect(mockApp.getInfo).not.toHaveBeenCalled()
    expect(mockLocalNotifications.checkPermissions).not.toHaveBeenCalled()
    expect(mockLocalNotifications.schedule).not.toHaveBeenCalled()
  })

  it('no-op on an old binary (build < 5) — never touches the plugin', async () => {
    buildOk(4)
    await syncLocalReminders()
    expect(mockLocalNotifications.checkPermissions).not.toHaveBeenCalled()
    expect(mockLocalNotifications.schedule).not.toHaveBeenCalled()
  })

  it('no-op when getInfo build is unreadable', async () => {
    mockApp.getInfo.mockResolvedValue({ build: 'not-a-number' })
    await syncLocalReminders()
    expect(mockLocalNotifications.checkPermissions).not.toHaveBeenCalled()
  })

  it('no-op when permission is denied', async () => {
    mockLocalNotifications.checkPermissions.mockResolvedValue({ display: 'denied' })
    fetchReturns([])
    await syncLocalReminders()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(mockLocalNotifications.schedule).not.toHaveBeenCalled()
  })

  it("requests permission once when 'prompt', then proceeds if granted", async () => {
    mockLocalNotifications.checkPermissions.mockResolvedValue({ display: 'prompt' })
    mockLocalNotifications.requestPermissions.mockResolvedValue({ display: 'granted' })
    fetchReturns([])
    await syncLocalReminders()
    expect(mockLocalNotifications.requestPermissions).toHaveBeenCalledTimes(1)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('happy path — schedules future reminders and stores their ids', async () => {
    const future = new Date(Date.now() + 2 * HOUR).toISOString()
    fetchReturns([{ id: 'uuid-1', title: 'পেমেন্ট', body: 'বিল দিন', dueAt: future }])
    await syncLocalReminders()

    expect(mockLocalNotifications.schedule).toHaveBeenCalledTimes(1)
    const arg = mockLocalNotifications.schedule.mock.calls[0][0]
    expect(arg.notifications).toHaveLength(1)
    const n = arg.notifications[0]
    expect(n).toEqual(
      expect.objectContaining({
        id: expect.any(Number),
        title: 'পেমেন্ট',
        body: 'বিল দিন',
        extra: { actionUrl: '/agent' },
      }),
    )
    expect(n.schedule.at instanceof Date).toBe(true)

    const stored = JSON.parse(localStorage.getItem(SCHEDULED_IDS_KEY)!)
    expect(stored).toEqual([n.id])
  })

  it('falls back to default body when reminder.body is empty', async () => {
    const future = new Date(Date.now() + HOUR).toISOString()
    fetchReturns([{ id: 'uuid-2', title: 'রিমাইন্ডার', body: null, dueAt: future }])
    await syncLocalReminders()
    const n = mockLocalNotifications.schedule.mock.calls[0][0].notifications[0]
    expect(n.body).toBe('ALMA ERP রিমাইন্ডার')
  })

  it('skips past-due reminders', async () => {
    const past = new Date(Date.now() - HOUR).toISOString()
    const future = new Date(Date.now() + HOUR).toISOString()
    fetchReturns([
      { id: 'past', title: 'পুরনো', body: null, dueAt: past },
      { id: 'future', title: 'ভবিষ্যৎ', body: null, dueAt: future },
    ])
    await syncLocalReminders()
    const arg = mockLocalNotifications.schedule.mock.calls[0][0]
    expect(arg.notifications).toHaveLength(1)
    expect(arg.notifications[0].title).toBe('ভবিষ্যৎ')
  })

  it('cancels exactly the previously-scheduled ids on the next sync', async () => {
    localStorage.setItem(SCHEDULED_IDS_KEY, JSON.stringify([111, 222]))
    fetchReturns([])
    await syncLocalReminders()
    expect(mockLocalNotifications.cancel).toHaveBeenCalledTimes(1)
    expect(mockLocalNotifications.cancel.mock.calls[0][0]).toEqual({
      notifications: [{ id: 111 }, { id: 222 }],
    })
  })

  it('swallows a fetch failure (resolves, never throws)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await expect(syncLocalReminders()).resolves.toBeUndefined()
    expect(mockLocalNotifications.schedule).not.toHaveBeenCalled()
  })

  it('no-op (returns) when fetch is non-OK', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }))
    await expect(syncLocalReminders()).resolves.toBeUndefined()
    expect(mockLocalNotifications.schedule).not.toHaveBeenCalled()
  })
})
