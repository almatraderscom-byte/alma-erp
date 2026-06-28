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

/**
 * Native (Capacitor) notification TAP handler.
 *
 * Without this, OneSignal falls back to its default launch-URL behaviour and
 * punts the URL to the system browser — so tapping an alert opened the web
 * site instead of the installed app. We strip `app_url` from the native push
 * payload (see src/lib/notifications.ts) and instead route the tap ourselves,
 * INSIDE the webview, using the `actionUrl` we ship in the notification data.
 * `allowNavigation` (capacitor.config.ts) keeps the production host in-shell.
 */
export async function listenForNativeNotificationClicks(): Promise<void> {
  if (!isCapacitorNative()) return
  try {
    const OneSignal = await getOneSignal()
    const notifications = OneSignal.Notifications as unknown as {
      addEventListener?: (
        event: 'click',
        listener: (event: { notification?: { additionalData?: unknown; launchURL?: string } }) => void,
      ) => void
    }
    notifications?.addEventListener?.('click', event => {
      const data = (event?.notification?.additionalData ?? {}) as { actionUrl?: string }
      const target = data.actionUrl || event?.notification?.launchURL
      if (!target) return
      try {
        // Resolve against the current origin so a relative path still works,
        // then navigate within the webview (full href keeps the production host
        // in-shell even during a cold start from the local bootstrap page).
        const url = new URL(target, window.location.origin)
        window.location.assign(url.href)
      } catch {
        // Malformed URL — ignore rather than crash the tap.
      }
    })
  } catch {
    // Non-critical: a failed listener must never break push registration.
  }
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
