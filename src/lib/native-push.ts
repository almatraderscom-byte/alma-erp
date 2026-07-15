import { Capacitor } from '@capacitor/core'
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

/**
 * Ask for the OS notification permission. `fallbackToSettings` deep-links the
 * user into the app's Settings page when the dialog was already denied — right
 * for an explicit button tap, wrong for the silent auto-ask on app open.
 */
export async function requestNativePushPermission(fallbackToSettings = true): Promise<boolean> {
  const OneSignal = await getOneSignal()
  return OneSignal.Notifications.requestPermission(fallbackToSettings)
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
      platform: Capacitor.getPlatform() === 'ios' ? 'ios-native' : 'android-native',
      userAgent: navigator.userAgent,
      enabled: true,
    }),
  })
  return res.ok
}

type AlmaNavBridgePlugin = { openPath: (options: { path: string }) => Promise<void> }

/**
 * The iOS shell's runtime-registered deep-link plugin (AlmaNavBridge.swift), or
 * undefined on Android/web and on old iOS builds that don't ship it.
 */
function getAlmaNavBridge(): AlmaNavBridgePlugin | undefined {
  const plugins = (window as unknown as { Capacitor?: { Plugins?: Record<string, unknown> } })
    ?.Capacitor?.Plugins
  const bridge = plugins?.AlmaNavBridge as AlmaNavBridgePlugin | undefined
  return bridge && typeof bridge.openPath === 'function' ? bridge : undefined
}

/**
 * Land a native notification tap on `url`.
 *
 * iOS: the Capacitor webview is tab 0 of the NATIVE tab shell and usually sits
 * hidden under SwiftUI screens — navigating it is invisible, which made every
 * tap look like "opens the dashboard". Hand the path to the native shell
 * (AlmaNavBridge → AlmaTabBarController.routeNotificationTap) so the exact
 * page opens natively. Old builds without the bridge fall back to the webview
 * navigation, which matches their (web-tab) UI.
 *
 * Android: single-webview app — navigating the webview IS the right routing.
 */
async function landNativeTap(url: URL): Promise<void> {
  if (url.origin === window.location.origin) {
    const bridge = getAlmaNavBridge()
    if (bridge && Capacitor.getPlatform() === 'ios') {
      try {
        await bridge.openPath({ path: `${url.pathname}${url.search}` })
        return
      } catch {
        // Bridge rejected (shouldn't happen) — fall back to webview navigation.
      }
    }
  }
  window.location.assign(url.href)
}

/**
 * Native (Capacitor) notification TAP handler.
 *
 * Without this, OneSignal falls back to its default launch-URL behaviour and
 * punts the URL to the system browser — so tapping an alert opened the web
 * site instead of the installed app. We strip `app_url` from the native push
 * payload (see src/lib/notifications.ts) and instead route the tap ourselves
 * using the `actionUrl` we ship in the notification data: natively via
 * AlmaNavBridge on iOS, inside the webview on Android (see landNativeTap).
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
      const data = (event?.notification?.additionalData ?? {}) as { actionUrl?: string; source?: string }
      // Agent pushes sent before the server-side '/agent' default existed (or by a
      // not-yet-redeployed worker) carry no actionUrl — still land them on the
      // agent chat instead of silently dropping the tap on the dashboard.
      const target = data.actionUrl
        || event?.notification?.launchURL
        || (data.source === 'agent' ? '/agent' : null)
      if (!target) return
      try {
        // Resolve against the current origin so a relative path still works,
        // then land the tap (full href keeps the production host in-shell even
        // during a cold start from the local bootstrap page).
        const url = new URL(target, window.location.origin)
        void landNativeTap(url)
      } catch {
        // Malformed URL — ignore rather than crash the tap.
      }
    })
  } catch {
    // Non-critical: a failed listener must never break push registration.
  }
}

/**
 * Re-register the moment the OS notification permission flips to granted —
 * e.g. the user came back from Settings after enabling notifications. Without
 * this the subscription stayed dead (OneSignal notification_types -10) until
 * some later focus event happened to re-register.
 */
export async function listenForPermissionChanges(input: NativePushRegisterInput): Promise<void> {
  if (!nativePushAvailable(input.appId)) return
  try {
    const OneSignal = await getOneSignal()
    const notifications = OneSignal.Notifications as unknown as {
      addEventListener?: (event: 'permissionChange', listener: (granted: boolean) => void) => void
    }
    notifications?.addEventListener?.('permissionChange', granted => {
      if (granted) void registerNativePushSubscription(input).catch(() => {})
    })
  } catch {
    // Non-critical — the focus re-register remains the fallback.
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
