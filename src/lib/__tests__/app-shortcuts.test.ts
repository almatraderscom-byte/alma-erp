import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the native plugin + platform detector BEFORE importing the module under test.
const mockAppShortcuts = vi.hoisted(() => ({ set: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@capawesome/capacitor-app-shortcuts', () => ({ AppShortcuts: mockAppShortcuts }))

const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import { QUICK_ACTIONS, registerAppShortcuts, shortcutPath } from '@/lib/app-shortcuts'

describe('QUICK_ACTIONS — static shortcut definitions', () => {
  it('has 4 entries with the expected ids', () => {
    expect(QUICK_ACTIONS).toHaveLength(4)
    expect(QUICK_ACTIONS.map(a => a.id)).toEqual(['orders', 'inventory', 'payroll', 'assistant'])
  })

  it('every path starts with "/"', () => {
    for (const action of QUICK_ACTIONS) {
      expect(action.path.startsWith('/')).toBe(true)
    }
  })
})

describe('shortcutPath — id → in-app route', () => {
  it('resolves known ids to their routes', () => {
    expect(shortcutPath('orders')).toBe('/orders')
    expect(shortcutPath('assistant')).toBe('/agent')
  })

  it('returns null for an unknown id', () => {
    expect(shortcutPath('nope')).toBeNull()
  })
})

describe('registerAppShortcuts — native-only, fail-open', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAppShortcuts.set.mockResolvedValue(undefined)
  })

  it('does NOT call AppShortcuts.set off native', async () => {
    mockNative.isCapacitorNative.mockReturnValue(false)
    await registerAppShortcuts()
    expect(mockAppShortcuts.set).not.toHaveBeenCalled()
  })

  it('on native → calls set once with 4 well-formed shortcuts', async () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    await registerAppShortcuts()
    expect(mockAppShortcuts.set).toHaveBeenCalledTimes(1)
    const arg = mockAppShortcuts.set.mock.calls[0][0]
    expect(arg.shortcuts).toHaveLength(4)
    for (const s of arg.shortcuts) {
      expect(s).toEqual(
        expect.objectContaining({
          id: expect.any(String),
          title: expect.any(String),
          description: expect.any(String),
          iosIcon: expect.any(String),
        }),
      )
    }
  })

  it('never throws even if AppShortcuts.set rejects (fail-open)', async () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    mockAppShortcuts.set.mockRejectedValueOnce(new Error('plugin blew up'))
    await expect(registerAppShortcuts()).resolves.toBeUndefined()
  })
})
