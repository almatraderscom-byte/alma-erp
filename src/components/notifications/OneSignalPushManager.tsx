'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSession } from 'next-auth/react'
import { useActor } from '@/contexts/ActorContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { isCapacitorNative } from '@/lib/capacitor-native'
import {
  ensureNativeOneSignalInitialized,
  nativePushAvailable,
  registerNativePushSubscription,
  requestNativePushPermission,
} from '@/lib/native-push'

type OneSignalSdk = {
  init: (input: {
    appId: string
    allowLocalhostAsSecureOrigin?: boolean
    serviceWorkerPath?: string
    serviceWorkerParam?: { scope: string }
    notifyButton?: { enable: boolean }
    autoResubscribe?: boolean
  }) => Promise<void>
  login?: (externalId: string) => Promise<void> | void
  User?: {
    addTags?: (tags: Record<string, string>) => Promise<void> | void
    PushSubscription?: {
      id?: string | null
      token?: string | null
      optedIn?: boolean
      optIn?: () => Promise<void> | void
      addEventListener?: (event: 'change', listener: (event: PushSubscriptionChangeEvent) => void) => void
      removeEventListener?: (event: 'change', listener: (event: PushSubscriptionChangeEvent) => void) => void
    }
  }
  Notifications?: {
    permission?: boolean
    requestPermission?: () => Promise<boolean>
  }
}

type PushSubscriptionState = {
  id?: string | null
  token?: string | null
  optedIn?: boolean
}

type PushSubscriptionChangeEvent = {
  previous: PushSubscriptionState
  current: PushSubscriptionState
}

declare global {
  interface Window {
    OneSignalDeferred?: Array<(OneSignal: OneSignalSdk) => void | Promise<void>>
    OneSignal?: OneSignalSdk
  }
}

const PROMPT_DISMISSED_KEY = 'alma_push_prompt_dismissed_at'
const REGISTERED_KEY_PREFIX = 'alma_push_registered:'
const PROMPT_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000
const SDK_LOAD_TIMEOUT_MS = 15_000
const PUSH_ENABLE_TIMEOUT_MS = 30_000

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      value => {
        window.clearTimeout(timer)
        resolve(value)
      },
      error => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function webPushSupported() {
  if (isCapacitorNative()) return false
  return typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window
    && window.isSecureContext
}

function loadOneSignalScript() {
  if (document.getElementById('onesignal-sdk')) return
  const script = document.createElement('script')
  script.id = 'onesignal-sdk'
  script.src = 'https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.page.js'
  script.defer = true
  document.head.appendChild(script)
}

function platformName() {
  const ua = navigator.userAgent
  if (/iphone|ipad|ipod/i.test(ua)) return 'ios-pwa'
  if (/android/i.test(ua)) return 'android'
  if (/macintosh|mac os/i.test(ua)) return 'macos'
  if (/windows/i.test(ua)) return 'windows'
  return 'web'
}

function notificationPermissionGranted() {
  return Notification.permission === 'granted'
}

async function waitForPushSubscription(sdk: OneSignalSdk) {
  const current = sdk.User?.PushSubscription
  if (current?.id || current?.token) return { id: current.id || null, token: current.token || null }

  return withTimeout(new Promise<{ id: string | null; token: string | null }>((resolve, reject) => {
    const pushSubscription = sdk.User?.PushSubscription
    if (!pushSubscription?.addEventListener || !pushSubscription.removeEventListener) {
      reject(new Error('OneSignal push subscription listener is unavailable'))
      return
    }

    const listener = (event: PushSubscriptionChangeEvent) => {
      const id = event.current.id || sdk.User?.PushSubscription?.id || null
      const token = event.current.token || sdk.User?.PushSubscription?.token || null
      if (!id && !token) return
      pushSubscription.removeEventListener?.('change', listener)
      resolve({ id, token })
    }

    pushSubscription.addEventListener('change', listener)
    window.setTimeout(() => {
      const id = sdk.User?.PushSubscription?.id || null
      const token = sdk.User?.PushSubscription?.token || null
      if (!id && !token) return
      pushSubscription.removeEventListener?.('change', listener)
      resolve({ id, token })
    }, 2_000)
  }), PUSH_ENABLE_TIMEOUT_MS, 'OneSignal did not return a push subscription')
}

export function OneSignalPushManager() {
  const appId = process.env.NEXT_PUBLIC_ONESIGNAL_APP_ID
  const { status, data: session } = useSession()
  const { role } = useActor()
  const { businessId, business } = useBusiness()
  const initPromiseRef = useRef<Promise<void> | null>(null)
  const [showPrompt, setShowPrompt] = useState(false)
  const [busy, setBusy] = useState(false)
  const [registered, setRegistered] = useState(false)
  const [promptError, setPromptError] = useState<string | null>(null)
  const userId = session?.user?.id || ''
  const employeeIdGas = session?.user?.employeeIdGas || null

  const nativeApp = useMemo(() => nativePushAvailable(appId), [appId])
  const webSupported = useMemo(() => Boolean(appId) && webPushSupported(), [appId])
  const pushReady = nativeApp || webSupported

  const markRegistered = useCallback(() => {
    if (userId) {
      localStorage.setItem(`${REGISTERED_KEY_PREFIX}${userId}`, String(Date.now()))
    }
    localStorage.setItem('alma_push_enabled', '1')
    setRegistered(true)
    window.dispatchEvent(new Event('alma-push-enabled'))
  }, [userId])

  const initializeOneSignal = useCallback((sdk: OneSignalSdk) => {
    if (!appId) return Promise.resolve()
    initPromiseRef.current ||= sdk.init({
      appId,
      allowLocalhostAsSecureOrigin: false,
      serviceWorkerPath: 'sw.js',
      serviceWorkerParam: { scope: '/' },
      notifyButton: { enable: false },
      autoResubscribe: true,
    })
    return initPromiseRef.current
  }, [appId])

  const getOneSignalSdk = useCallback(async () => {
    if (window.OneSignal) return window.OneSignal
    window.OneSignalDeferred = window.OneSignalDeferred || []
    loadOneSignalScript()
    return withTimeout(new Promise<OneSignalSdk>(resolve => {
      window.OneSignalDeferred?.push(sdk => resolve(sdk))
    }), SDK_LOAD_TIMEOUT_MS, 'OneSignal SDK did not load')
  }, [])

  const registerWebSubscription = useCallback(async (sdk: OneSignalSdk) => {
    if (!appId || !userId) return false
    await initializeOneSignal(sdk)
    await sdk.login?.(userId)
    await sdk.User?.addTags?.({
      userId,
      role,
      businessId,
      businessName: business.name,
      employeeIdGas: employeeIdGas || '',
      app: 'alma-erp',
    })
    await sdk.User?.PushSubscription?.optIn?.()
    const subscription = await waitForPushSubscription(sdk)
    const playerId = subscription.id
    const endpoint = subscription.token
    if (!playerId && !endpoint) throw new Error('OneSignal subscription was not created')
    const res = await fetch('/api/notifications/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: 'onesignal',
        playerId,
        endpoint,
        externalUserId: userId,
        businessId,
        role,
        employeeIdGas,
        platform: platformName(),
        userAgent: navigator.userAgent,
        enabled: true,
      }),
    })
    if (!res.ok) throw new Error(`Subscription registration failed with ${res.status}`)
    markRegistered()
    return true
  }, [appId, business.name, businessId, employeeIdGas, initializeOneSignal, markRegistered, role, userId])

  const enablePush = useCallback(async () => {
    if (!pushReady || busy || !appId || !userId) return
    setBusy(true)
    setPromptError(null)
    try {
      if (nativeApp) {
        await withTimeout(ensureNativeOneSignalInitialized(appId), PUSH_ENABLE_TIMEOUT_MS, 'Native push could not initialize')
        const granted = await withTimeout(requestNativePushPermission(), PUSH_ENABLE_TIMEOUT_MS, 'Notification permission request timed out')
        if (!granted) {
          setPromptError('Phone Settings → Apps → Alma ERP → Notifications → Allow all চালু করুন, তারপর আবার চেষ্টা করুন।')
          return
        }
        const connected = await withTimeout(
          registerNativePushSubscription({
            appId,
            userId,
            role,
            businessId,
            businessName: business.name,
            employeeIdGas,
          }),
          PUSH_ENABLE_TIMEOUT_MS,
          'Native push subscription registration timed out',
        )
        if (connected) {
          markRegistered()
          setShowPrompt(false)
        } else {
          setPromptError('Permission দেওয়া হয়েছে, কিন্তু device register হয়নি। Firebase setup শেষ হয়েছে কিনা চেক করুন, তারপর আবার চেষ্টা করুন।')
        }
        return
      }

      const sdk = await getOneSignalSdk()
      await withTimeout(initializeOneSignal(sdk), SDK_LOAD_TIMEOUT_MS, 'OneSignal could not initialize')
      if (!notificationPermissionGranted()) {
        const granted = await withTimeout(
          sdk.Notifications?.requestPermission?.() || Promise.resolve(notificationPermissionGranted()),
          PUSH_ENABLE_TIMEOUT_MS,
          'Notification permission request timed out',
        )
        if (granted === false || !notificationPermissionGranted()) {
          localStorage.setItem(PROMPT_DISMISSED_KEY, String(Date.now()))
          setShowPrompt(false)
          return
        }
      }
      const connected = await withTimeout(registerWebSubscription(sdk), PUSH_ENABLE_TIMEOUT_MS, 'Push subscription registration timed out')
      if (connected) {
        setShowPrompt(false)
      } else {
        setPromptError('Push permission was allowed, but the device subscription was not ready yet. Please try again.')
      }
    } catch (error) {
      console.warn('[OneSignal] push enable failed', error)
      setPromptError(nativeApp
        ? 'Native alert চালু হয়নি। Firebase + OneSignal Android setup শেষ হয়েছে কিনা দেখুন।'
        : 'Could not connect push alerts. Please try again.')
    } finally {
      setBusy(false)
    }
  }, [appId, busy, business.name, businessId, employeeIdGas, getOneSignalSdk, initializeOneSignal, markRegistered, nativeApp, pushReady, registerWebSubscription, role, userId])

  useEffect(() => {
    if (!nativeApp || !appId) return
    void ensureNativeOneSignalInitialized(appId).catch(error => {
      console.warn('[native-push] init failed', error)
    })
  }, [appId, nativeApp])

  useEffect(() => {
    if (status !== 'authenticated' || !pushReady || !userId) return
    if (!nativeApp && Notification.permission === 'denied') return
    const dismissedAt = Number(localStorage.getItem(PROMPT_DISMISSED_KEY) || 0)
    const registeredAt = Number(localStorage.getItem(`${REGISTERED_KEY_PREFIX}${userId}`) || 0)
    if (registeredAt && Date.now() - registeredAt < PROMPT_COOLDOWN_MS) {
      setRegistered(true)
      return
    }
    if (dismissedAt && Date.now() - dismissedAt < PROMPT_COOLDOWN_MS) return
    const timer = window.setTimeout(() => setShowPrompt(true), 7_000)
    return () => window.clearTimeout(timer)
  }, [nativeApp, pushReady, status, userId])

  useEffect(() => {
    function openPrompt() {
      if (pushReady) setShowPrompt(true)
    }
    function registerSilently() {
      if (!webSupported || Notification.permission !== 'granted' || !window.OneSignal) return
      void registerWebSubscription(window.OneSignal)
    }
    window.addEventListener('alma-enable-push', openPrompt)
    window.addEventListener('focus', registerSilently)
    return () => {
      window.removeEventListener('alma-enable-push', openPrompt)
      window.removeEventListener('focus', registerSilently)
    }
  }, [pushReady, registerWebSubscription, webSupported])

  if (!showPrompt || registered || !pushReady) return null

  return (
    <div className="fixed inset-x-3 bottom-[calc(5.8rem+env(safe-area-inset-bottom,0px))] z-[215] mx-auto max-w-md rounded-[26px] border border-gold-dim/40 bg-[#09090d]/95 p-4 text-cream shadow-2xl shadow-black/60 backdrop-blur-2xl md:bottom-5">
      <div className="flex items-start gap-3">
        <div className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl border border-gold-dim/45 bg-gold/10 text-lg font-black text-gold-lt">
          A
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-black">
            {nativeApp ? 'Phone alert চালু করুন' : 'Enable Alma alerts'}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-zinc-400">
            {nativeApp
              ? `Alma ERP app থেকে lock-screen alert পাবেন — order, payroll, inventory alert ${business.shortName}-এর জন্য।`
              : `Get order, payroll, inventory, and admin alerts on your lock screen for ${business.shortName}.`}
          </p>
          {promptError && (
            <p className="mt-2 rounded-xl border border-red-400/30 bg-red-500/10 px-3 py-2 text-[11px] font-semibold text-red-200">
              {promptError}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void enablePush()}
              className="rounded-xl border border-gold-dim/50 bg-gold/15 px-3 py-2 text-[11px] font-black text-gold-lt active:scale-[0.98] disabled:opacity-60"
            >
              {busy ? 'Connecting…' : nativeApp ? 'Allow notifications' : 'Enable alerts'}
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.setItem(PROMPT_DISMISSED_KEY, String(Date.now()))
                setShowPrompt(false)
              }}
              className="rounded-xl border border-border bg-white/[0.03] px-3 py-2 text-[11px] font-bold text-zinc-400 active:scale-[0.98]"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
