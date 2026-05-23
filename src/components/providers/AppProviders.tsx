'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type { Session } from 'next-auth'
import { SessionProvider, signOut, useSession } from 'next-auth/react'
import { usePathname, useRouter } from 'next/navigation'
import { Button } from '@/components/ui'
import { BusinessProvider } from '@/contexts/BusinessContext'
import { useBusiness } from '@/contexts/BusinessContext'
import { ActorProvider } from '@/contexts/ActorContext'
import { BrandingProvider } from '@/contexts/BrandingContext'
import { BrandingHead } from '@/components/branding/BrandingHead'
import { DateRangeProvider } from '@/contexts/DateRangeContext'
import { OrdersDataProvider } from '@/contexts/OrdersDataContext'
import { OrdersDataErrorBoundary } from '@/components/providers/OrdersDataErrorBoundary'
import { Sidebar } from '@/components/layout/Sidebar'
import { MobileBottomSpacer, MobileNavBar } from '@/components/layout/MobileNavChrome'
import { PwaBootstrap } from '@/components/providers/PwaBootstrap'
import { LoadingOverlay } from '@/components/loading/LoadingOverlay'
import { RouteTransitionLoader } from '@/components/loading/RouteTransitionLoader'
import { MobileRefreshProvider } from '@/contexts/MobileRefreshContext'
import { ApprovalCountProvider } from '@/contexts/ApprovalCountContext'
import { MobilePullToRefresh } from '@/components/mobile/MobilePullToRefresh'
import { SentryUserBridge } from '@/components/providers/SentryUserBridge'

const NotificationShellProvider = dynamic(
  () => import('@/contexts/NotificationShellContext').then(mod => mod.NotificationShellProvider),
  { ssr: false, loading: () => null },
)
const OneSignalPushManager = dynamic(
  () => import('@/components/notifications/OneSignalPushManager').then(mod => mod.OneSignalPushManager),
  { ssr: false, loading: () => null },
)

function RoutePrefetcher() {
  const router = useRouter()
  const { businessId } = useBusiness()

  useEffect(() => {
    const routes = businessId === 'ALMA_TRADING'
      ? ['/', '/trading', '/trading/accounts', '/trading/analytics', '/approvals', '/payroll']
      : ['/', '/orders', '/orders/new', '/inventory', '/invoice', '/approvals', '/payroll']
    let cancelled = false
    const prefetch = () => {
      if (cancelled || typeof document !== 'undefined' && document.hidden) return
      for (const route of routes) router.prefetch(route)
    }
    const win = window as Window & {
      requestIdleCallback?: (callback: IdleRequestCallback, options?: IdleRequestOptions) => number
      cancelIdleCallback?: (handle: number) => void
    }
    const idle = win.requestIdleCallback
      ? win.requestIdleCallback(prefetch, { timeout: 2500 })
      : window.setTimeout(prefetch, 1200)
    return () => {
      cancelled = true
      if (win.cancelIdleCallback) win.cancelIdleCallback(idle)
      else window.clearTimeout(idle)
    }
  }, [businessId, router])

  return null
}

function ErpChrome({ children }: { children: ReactNode }) {
  const mainScrollRef = useRef<HTMLElement>(null)

  return (
    <ApprovalCountProvider>
      <NotificationShellProvider>
        <SentryUserBridge />
        <div className="flex h-[100dvh] w-full overflow-hidden">
          <Sidebar />
          <main ref={mainScrollRef} className="flex-1 overflow-y-auto min-w-0 scrollbar-hide overscroll-y-contain">
            <MobilePullToRefresh scrollRef={mainScrollRef}>
              {children}
              <MobileBottomSpacer />
            </MobilePullToRefresh>
          </main>
        </div>
        <MobileNavBar />
        <RouteTransitionLoader />
        <RoutePrefetcher />
        <OneSignalPushManager />
      </NotificationShellProvider>
    </ApprovalCountProvider>
  )
}

/** Orders context is always mounted; fetch is scoped inside the provider by business + route. */
function OrdersDataScope({ children }: { children: ReactNode }) {
  return (
    <OrdersDataProvider>
      <OrdersDataErrorBoundary>{children}</OrdersDataErrorBoundary>
    </OrdersDataProvider>
  )
}

const AUTH_LOADING_TIMEOUT_MS = 10_000
const AUTH_REDIRECT_TIMEOUT_MS = 5_000
const AUTH_RETRY_STORAGE_KEY = 'alma-auth-loading-retries'

async function forceRelogin() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event('alma:force-relogin'))
    try {
      sessionStorage.removeItem(AUTH_RETRY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
  await signOut({ redirect: false })
  if (typeof window !== 'undefined') {
    window.location.href = '/login'
  }
}

function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const isPublic =
    pathname.startsWith('/login')
    || pathname.startsWith('/forgot-password')
    || pathname.startsWith('/reset-password')

  useEffect(() => {
    if (status === 'authenticated') {
      try {
        sessionStorage.removeItem(AUTH_RETRY_STORAGE_KEY)
      } catch {
        /* ignore */
      }
      setLoadingTimedOut(false)
      setRetryCount(0)
    }
  }, [status])

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      setRetryCount(Number(sessionStorage.getItem(AUTH_RETRY_STORAGE_KEY) || 0))
    } catch {
      setRetryCount(0)
    }
  }, [])

  useEffect(() => {
    if (status !== 'loading') {
      setLoadingTimedOut(false)
      return
    }
    const timer = window.setTimeout(() => setLoadingTimedOut(true), AUTH_LOADING_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [status])

  useEffect(() => {
    if (status !== 'unauthenticated' || typeof window === 'undefined') return
    router.replace(`/login?callbackUrl=${encodeURIComponent(pathname)}`)
    const timer = window.setTimeout(() => {
      window.location.href = `/login?callbackUrl=${encodeURIComponent(pathname)}`
    }, AUTH_REDIRECT_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [status, pathname, router])

  if (isPublic) {
    return <>{children}</>
  }

  if (status === 'loading') {
    if (loadingTimedOut) {
      const showForceRelogin = retryCount >= 3
      return (
        <div className="fixed inset-0 z-[240] flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-black px-6 text-center">
          <p className="text-sm font-semibold text-cream">Session check timed out</p>
          <p className="max-w-sm text-[11px] text-zinc-500">
            The app could not verify your sign-in. Check your connection and try again.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            {!showForceRelogin && (
              <Button
                variant="gold"
                size="sm"
                onClick={() => {
                  const next = retryCount + 1
                  try {
                    sessionStorage.setItem(AUTH_RETRY_STORAGE_KEY, String(next))
                  } catch {
                    /* ignore */
                  }
                  setRetryCount(next)
                  window.location.reload()
                }}
              >
                Retry
              </Button>
            )}
            {showForceRelogin && (
              <Button variant="gold" size="sm" onClick={() => void forceRelogin()}>
                Force re-login
              </Button>
            )}
          </div>
        </div>
      )
    }
    return <LoadingOverlay label="Authenticating" />
  }

  if (status === 'unauthenticated') {
    return <LoadingOverlay label="Redirecting to login" />
  }

  return (
    <BusinessProvider allowedBusinessAccess={session?.user?.businessAccess}>
      <ActorProvider>
        <BrandingProvider>
          <BrandingHead />
          <DateRangeProvider>
            <MobileRefreshProvider>
              <OrdersDataScope>
                <ErpChrome>{children}</ErpChrome>
              </OrdersDataScope>
            </MobileRefreshProvider>
          </DateRangeProvider>
        </BrandingProvider>
      </ActorProvider>
    </BusinessProvider>
  )
}

export function AppProviders({
  children,
  session,
}: {
  children: ReactNode
  session: Session | null
}) {
  return (
    <SessionProvider session={session}>
      <PwaBootstrap />
      <AuthGate>{children}</AuthGate>
    </SessionProvider>
  )
}
