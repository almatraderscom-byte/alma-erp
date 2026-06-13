import { isCapacitorNative } from '@/lib/capacitor-native'

export type NativePushRegisterInput = {
  appId: string
  userId: string
  role: string
  businessId: string
  businessName: string
  employeeIdGas?: string | null
}

let initializedAppId: string | null = null

async function getOneSignal() {
  const mod = await import('@onesignal/capacitor-plugin')
  return mod.default
}

export function nativePushAvailable(appId?: string | null): boolean {
  return isCapacitorNative() && Boolean(appId?.trim())
}

export async function ensureNativeOneSignalInitialized(appId: string): Promise<void> {
  if (!nativePushAvailable(appId) || initializedAppId === appId) return
  const OneSignal = await getOneSignal()
  await OneSignal.initialize(appId)
  initializedAppId = appId
}

export async function nativePushHasPermission(): Promise<boolean> {
  const OneSignal = await getOneSignal()
  return OneSignal.Notifications.hasPermission()
}

export async function requestNativePushPermission(): Promise<boolean> {
  const OneSignal = await getOneSignal()
  return OneSignal.Notifications.requestPermission(true)
}

export async function registerNativePushSubscription(input: NativePushRegisterInput): Promise<boolean> {
  await ensureNativeOneSignalInitialized(input.appId)
  const OneSignal = await getOneSignal()

  await OneSignal.login(input.userId)
  await OneSignal.User.addTags({
    userId: input.userId,
    role: input.role,
    businessId: input.businessId,
    businessName: input.businessName,
    employeeIdGas: input.employeeIdGas || '',
    app: 'alma-erp-native',
  })
  await OneSignal.User.pushSubscription.optIn()

  const playerId = await OneSignal.User.pushSubscription.getIdAsync()
  const token = await OneSignal.User.pushSubscription.getTokenAsync()
  if (!playerId && !token) return false

  const res = await fetch('/api/notifications/subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: 'onesignal',
      playerId,
      endpoint: token,
      externalUserId: input.userId,
      businessId: input.businessId,
      role: input.role,
      employeeIdGas: input.employeeIdGas || null,
      platform: 'android-native',
      userAgent: navigator.userAgent,
      enabled: true,
    }),
  })
  return res.ok
}

/** Re-register whenever OneSignal detects a push token change (FCM rotation). */
export async function listenForTokenChanges(input: NativePushRegisterInput): Promise<void> {
  if (!nativePushAvailable(input.appId)) return
  try {
    const OneSignal = await getOneSignal()
    const sub = OneSignal.User?.pushSubscription as {
      addEventListener?: (event: 'change', listener: () => void) => void
    } | undefined
    sub?.addEventListener?.('change', () => {
      void registerNativePushSubscription(input).catch(() => {})
    })
  } catch {
    // Non-critical — next focus event will re-register anyway
  }
}
