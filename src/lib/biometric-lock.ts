/**
 * Face ID / Touch ID app lock for the native iOS shell.
 *
 * The shell loads the LIVE site inside WKWebView, so this gate ships to every
 * install the moment it deploys. It is iOS-native only (Android already has its
 * own lockscreen story) and is bulletproof fail-open: any plugin error, missing
 * hardware, or unenrolled biometry leaves the app fully usable. iOS is allowed
 * to fall back to the device passcode (allowDeviceCredential), so a failed face
 * scan can never lock the owner out.
 *
 * Enable state lives in localStorage so the owner can toggle it without a new
 * build (see BiometricLockGate + the settings toggle). Default: ON for iOS
 * native, because that is the whole point of the feature.
 */
import { BiometricAuth, BiometryError, BiometryErrorType } from '@aparajita/capacitor-biometric-auth'
import { isCapacitorNative } from '@/lib/capacitor-native'

/** Error codes that mean "there is nothing to authenticate against" → fail open. */
const FAIL_OPEN_CODES: ReadonlySet<BiometryErrorType> = new Set([
  BiometryErrorType.biometryNotAvailable,
  BiometryErrorType.biometryNotEnrolled,
  BiometryErrorType.passcodeNotSet,
  BiometryErrorType.noDeviceCredential,
])

const ENABLED_KEY = 'alma_biometric_lock_enabled'

/** iOS-native only — Android/web never gate on Face ID here. */
export function biometricLockPlatform(): boolean {
  if (!isCapacitorNative()) return false
  const cap = (window as Window & { Capacitor?: { getPlatform?: () => string } }).Capacitor
  return cap?.getPlatform?.() === 'ios'
}

/** Owner preference. Defaults ON for iOS native; explicit '0' turns it off. */
export function isBiometricLockEnabled(): boolean {
  if (!biometricLockPlatform()) return false
  try {
    return window.localStorage.getItem(ENABLED_KEY) !== '0'
  } catch {
    return true
  }
}

export function setBiometricLockEnabled(on: boolean): void {
  try {
    window.localStorage.setItem(ENABLED_KEY, on ? '1' : '0')
  } catch {
    /* private mode / storage disabled — nothing we can do, stay fail-open */
  }
}

/** True only when the device actually has usable biometry (or a passcode fallback). */
export async function biometryAvailable(): Promise<boolean> {
  if (!biometricLockPlatform()) return false
  try {
    const info = await BiometricAuth.checkBiometry()
    // isAvailable covers Face ID / Touch ID; deviceIsSecure covers passcode fallback.
    return Boolean(info.isAvailable || info.deviceIsSecure)
  } catch {
    return false
  }
}

export type UnlockResult = 'unlocked' | 'cancelled' | 'unavailable'

/**
 * Prompt for Face ID / Touch ID (with passcode fallback). Returns:
 * - 'unlocked'     → authenticated, let the app through
 * - 'cancelled'    → user dismissed / failed; caller should keep the lock and offer retry
 * - 'unavailable'  → no biometry AND no passcode, or plugin error → caller MUST fail open
 */
export async function runBiometricUnlock(): Promise<UnlockResult> {
  if (!biometricLockPlatform()) return 'unavailable'
  try {
    await BiometricAuth.authenticate({
      reason: 'ALMA ERP আনলক করতে Face ID ব্যবহার করুন',
      cancelTitle: 'বাতিল',
      allowDeviceCredential: true,
      iosFallbackTitle: 'পাসকোড ব্যবহার করুন',
    })
    return 'unlocked'
  } catch (err) {
    if (err instanceof BiometryError) {
      // No biometry AND no passcode to fall back to → we must NOT trap the user.
      if (FAIL_OPEN_CODES.has(err.code)) return 'unavailable'
      // userCancel / authenticationFailed / systemCancel / userFallback etc → keep locked.
      return 'cancelled'
    }
    // Unknown/unexpected error → fail open rather than risk a permanent lockout.
    return 'unavailable'
  }
}
