import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// --- Mock the native biometric plugin BEFORE importing the module under test. ---
// We provide a controllable BiometricAuth (checkBiometry / authenticate) plus a
// real BiometryError class and a BiometryErrorType enum whose members are
// string-valued equal to their names (userCancel === 'userCancel', ...).
const mockBiometric = vi.hoisted(() => {
  const BiometryErrorType = {
    none: 'none',
    appCancel: 'appCancel',
    authenticationFailed: 'authenticationFailed',
    invalidContext: 'invalidContext',
    notInteractive: 'notInteractive',
    passcodeNotSet: 'passcodeNotSet',
    systemCancel: 'systemCancel',
    userCancel: 'userCancel',
    userFallback: 'userFallback',
    biometryLockout: 'biometryLockout',
    biometryNotAvailable: 'biometryNotAvailable',
    biometryNotEnrolled: 'biometryNotEnrolled',
    noDeviceCredential: 'noDeviceCredential',
  } as const

  class BiometryError extends Error {
    code: string
    constructor(message: string, code: string) {
      super(message)
      this.name = 'BiometryError'
      this.code = code
    }
  }

  return {
    BiometryErrorType,
    BiometryError,
    BiometricAuth: {
      checkBiometry: vi.fn(),
      authenticate: vi.fn(),
    },
  }
})
vi.mock('@aparajita/capacitor-biometric-auth', () => ({
  BiometricAuth: mockBiometric.BiometricAuth,
  BiometryError: mockBiometric.BiometryError,
  BiometryErrorType: mockBiometric.BiometryErrorType,
}))

// --- Mock the capacitor-native detector. ---
const mockNative = vi.hoisted(() => ({ isCapacitorNative: vi.fn() }))
vi.mock('@/lib/capacitor-native', () => mockNative)

import {
  biometricLockPlatform,
  isBiometricLockEnabled,
  runBiometricUnlock,
} from '@/lib/biometric-lock'

const { BiometricAuth, BiometryError, BiometryErrorType } = mockBiometric

// --- Minimal browser globals (vitest env is 'node'). ---
const store = new Map<string, string>()
const fakeLocalStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
}

/** Point window.Capacitor.getPlatform at the given platform (or undefined = no Capacitor). */
function setPlatform(platform: string | undefined) {
  if (platform === undefined) {
    ;(window as any).Capacitor = undefined
    return
  }
  ;(window as any).Capacitor = { getPlatform: () => platform }
}

beforeEach(() => {
  vi.clearAllMocks()
  store.clear()
  ;(globalThis as any).window = globalThis as any
  ;(window as any).localStorage = fakeLocalStorage
  setPlatform('ios')
})

afterEach(() => {
  ;(window as any).Capacitor = undefined
})

describe('biometricLockPlatform — iOS-native only', () => {
  it('true when native AND platform is ios', () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('ios')
    expect(biometricLockPlatform()).toBe(true)
  })

  it('false on android even when native', () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('android')
    expect(biometricLockPlatform()).toBe(false)
  })

  it('false on web even when platform reads ios', () => {
    mockNative.isCapacitorNative.mockReturnValue(false)
    setPlatform('ios')
    expect(biometricLockPlatform()).toBe(false)
  })

  it('false when Capacitor is missing entirely', () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform(undefined)
    expect(biometricLockPlatform()).toBe(false)
  })
})

describe('isBiometricLockEnabled — default ON for iOS native', () => {
  it('defaults to true on iOS native with no stored preference', () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('ios')
    expect(isBiometricLockEnabled()).toBe(true)
  })

  it("false when the stored preference is '0'", () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('ios')
    store.set('alma_biometric_lock_enabled', '0')
    expect(isBiometricLockEnabled()).toBe(false)
  })

  it("true when the stored preference is anything but '0'", () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('ios')
    store.set('alma_biometric_lock_enabled', '1')
    expect(isBiometricLockEnabled()).toBe(true)
  })

  it('false on non-iOS regardless of stored preference', () => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('android')
    store.set('alma_biometric_lock_enabled', '1')
    expect(isBiometricLockEnabled()).toBe(false)
  })
})

describe('runBiometricUnlock — result mapping', () => {
  beforeEach(() => {
    mockNative.isCapacitorNative.mockReturnValue(true)
    setPlatform('ios')
  })

  it("returns 'unlocked' when authenticate resolves", async () => {
    BiometricAuth.authenticate.mockResolvedValue(undefined)
    await expect(runBiometricUnlock()).resolves.toBe('unlocked')
  })

  it("returns 'unavailable' off-platform without prompting", async () => {
    setPlatform('android')
    await expect(runBiometricUnlock()).resolves.toBe('unavailable')
    expect(BiometricAuth.authenticate).not.toHaveBeenCalled()
  })

  const failOpen = [
    BiometryErrorType.biometryNotAvailable,
    BiometryErrorType.biometryNotEnrolled,
    BiometryErrorType.passcodeNotSet,
    BiometryErrorType.noDeviceCredential,
  ]
  for (const code of failOpen) {
    it(`returns 'unavailable' for fail-open code ${code}`, async () => {
      BiometricAuth.authenticate.mockRejectedValue(new BiometryError('nope', code))
      await expect(runBiometricUnlock()).resolves.toBe('unavailable')
    })
  }

  const keepLocked = [BiometryErrorType.userCancel, BiometryErrorType.authenticationFailed]
  for (const code of keepLocked) {
    it(`returns 'cancelled' for keep-locked code ${code}`, async () => {
      BiometricAuth.authenticate.mockRejectedValue(new BiometryError('nope', code))
      await expect(runBiometricUnlock()).resolves.toBe('cancelled')
    })
  }

  it("returns 'unavailable' for a non-BiometryError (fail open)", async () => {
    BiometricAuth.authenticate.mockRejectedValue(new Error('boom'))
    await expect(runBiometricUnlock()).resolves.toBe('unavailable')
  })
})
