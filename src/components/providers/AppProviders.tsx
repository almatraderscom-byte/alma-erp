'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type { Session } from 'next-auth'
import { SessionProvider, getSession, signOut, useSession } from 'next-auth/react'
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
import { AgentFab } from '@/components/layout/AgentAccess'
import { PwaBootstrap } from '@/components/providers/PwaBootstrap'
import { AppBootRecovery, AppReadyMarker } from '@/components/providers/AppBootRecovery'
import { LoadingOverlay } from '@/components/loading/LoadingOverlay'
import { RouteTransitionLoader } from '@/components/loading/RouteTransitionLoader'
import { PageFade } from '@/components/layout/PageFade'
import { CommandPalette } from '@/components/command/CommandPalette'
import { MobileRefreshProvider } from '@/contexts/MobileRefreshContext'
import { ApprovalCountProvider } from '@/contexts/ApprovalCountContext'
import { MobilePullToRefresh } from '@/components/mobile/MobilePullToRefresh'
import { SentryUserBridge } from '@/components/providers/SentryUserBridge'
import { isPublicPath } from '@/lib/auth-paths'
import { fetchWithTimeout } from '@/lib/fetch-timeout'
import { cn } from '@/lib/utils'

const NotificationShellProvider = dynamic(
  () => import('@/contexts/NotificationShellContext').then(mod => mod.NotificationShellProvider),
  { ssr: false, loading: () => null },
)
const OneSignalPushManager = dynamic(
  () => import('@/components/notifications/OneSignalPushManager').then(mod => mod.OneSignalPushManager),
  { ssr: false, loading: () => null },
)
const NotificationSoundBridge = dynamic(
  () => import('@/components/notifications/NotificationSoundBridge').then(mod => mod.NotificationSoundBridge),
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

function useIsAgentRoute() {
  const path = usePathname() ?? ''
  return path.startsWith('/agent')
}

function ErpChrome({ children }: { children: ReactNode }) {
  const mainScrollRef = useRef<HTMLElement>(null)
  const isAgent = useIsAgentRoute()

  return (
    <ApprovalCountProvider>
      <NotificationShellProvider>
        <SentryUserBridge />
        <div className="relative z-10 flex h-[100dvh] w-full min-w-0 overflow-hidden">
          {!isAgent && <Sidebar />}
          <main
            ref={mainScrollRef}
            className={cn(
              // On mobile (the iOS WKWebView app) the shell must NOT scroll/pan
              // horizontally — that was what slid the whole layout on touch. Clip
              // it (overflow-x-hidden) so the page is locked; every genuinely wide
              // table on a page already has its OWN overflow-x-auto scroller, so
              // nothing legitimately needs page-level horizontal scroll on mobile.
              // Desktop (md+) keeps overflow-x-auto. overscroll-x-none stops any
              // residual horizontal rubber-band on desktop too.
              // [-webkit-overflow-scrolling:touch] gives this main scroller iOS
              // momentum scrolling — without it the WKWebView scroll feels stuck
              // and stutters after the first drag. Harmless for the agent branch
              // (it's overflow-hidden there; the inner wrappers do the scrolling).
              'flex-1 min-w-0 scrollbar-hide overscroll-y-contain overscroll-x-none [-webkit-overflow-scrolling:touch]',
              isAgent
                ? 'overflow-hidden'
                : 'overflow-x-hidden overflow-y-auto md:overflow-x-auto',
            )}
          >
            {isAgent ? (
              <div data-page-fade className="flex h-full min-h-0 min-w-0 flex-col">{children}</div>
            ) : (
              <MobilePullToRefresh scrollRef={mainScrollRef}>
                <div data-page-fade className="min-w-0 max-w-full">{children}</div>
                <MobileBottomSpacer />
              </MobilePullToRefresh>
            )}
          </main>
        </div>
        <MobileNavBar />
        <AgentFab />
        <RouteTransitionLoader />
        <PageFade />
        <CommandPalette />
        <RoutePrefetcher />
        <OneSignalPushManager />
        <NotificationSoundBridge />
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

const AUTH_LOADING_TIMEOUT_MS = 18_000
/** Session API is fast (~400ms); probing sooner avoids a false “stuck loading” UX on cold starts. */
const AUTH_SESSION_PROBE_MS = 1_500
const AUTH_SESSION_FETCH_MS = 8_000
const AUTH_REDIRECT_GUARD_KEY = 'alma_auth_redirect_guard'
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

function AuthGate({ children, initialSession }: { children: ReactNode; initialSession: Session | null }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const [loadingTimedOut, setLoadingTimedOut] = useState(false)
  const [sessionStuck, setSessionStuck] = useState(false)
  const [retryCount, setRetryCount] = useState(0)

  const isPublic = isPublicPath(pathname ?? '')
  const sessionUser = session?.user ?? initialSession?.user
  const isAuthed = Boolean(sessionUser)
  const isBooting = status === 'loading' && !sessionUser

  useEffect(() => {
    if (status === 'authenticated') {
      try {
        sessionStorage.removeItem(AUTH_RETRY_STORAGE_KEY)
        sessionStorage.removeItem(AUTH_REDIRECT_GUARD_KEY)
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
    if (status !== 'loading' || isPublic || typeof window === 'undefined') return
    let cancelled = false

    // Middleware already validated the cookie; nudge SessionProvider immediately.
    void getSession()

    const probe = async () => {
      try {
        const res = await fetchWithTimeout(
          '/api/auth/session',
          { cache: 'no-store', credentials: 'same-origin' },
          AUTH_SESSION_FETCH_MS,
        )
        if (cancelled) return
        if (!res.ok) {
          setSessionStuck(true)
          return
        }
        const body = await res.json().catch(() => null) as { user?: unknown } | null
        if (body?.user) {
          // Cookie session exists — client SessionProvider is slow; do not bounce to login.
          void getSession()
          return
        }
        setSessionStuck(true)
      } catch {
        if (!cancelled) setSessionStuck(true)
      }
    }

    const timer = window.setTimeout(() => void probe(), AUTH_SESSION_PROBE_MS)
    const timeoutTimer = window.setTimeout(() => setLoadingTimedOut(true), AUTH_LOADING_TIMEOUT_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(timeoutTimer)
    }
  }, [status, isPublic])

  useEffect(() => {
    if (status !== 'loading') {
      setLoadingTimedOut(false)
      setSessionStuck(false)
      return
    }
  }, [status])

  useEffect(() => {
    if (!sessionStuck || isPublic || isAuthed || typeof window === 'undefined') return
    try {
      const raw = sessionStorage.getItem(AUTH_REDIRECT_GUARD_KEY)
      const guard = raw ? JSON.parse(raw) as { count: number; at: number } : { count: 0, at: 0 }
      if (guard.count >= 2 && Date.now() - guard.at < 30_000) {
        setLoadingTimedOut(true)
        setSessionStuck(false)
        return
      }
      sessionStorage.setItem(
        AUTH_REDIRECT_GUARD_KEY,
        JSON.stringify({ count: guard.count + 1, at: Date.now() }),
      )
    } catch {
      /* ignore */
    }
    const returnTo = `${pathname}${window.location.search}`
    const loginUrl = `/login?callbackUrl=${encodeURIComponent(returnTo)}`
    window.location.replace(loginUrl)
  }, [sessionStuck, isPublic, isAuthed, pathname])

  useEffect(() => {
    if (isPublic || status !== 'unauthenticated' || typeof window === 'undefined') return
    const returnTo = `${pathname}${window.location.search}`
    const loginUrl = `/login?callbackUrl=${encodeURIComponent(returnTo)}`
    const timer = window.setTimeout(() => {
      window.location.replace(loginUrl)
    }, 400)
    return () => window.clearTimeout(timer)
  }, [isPublic, status, pathname])

  useEffect(() => {
    if (typeof window === 'undefined') return
    let debounce: number | null = null
    const onAuthFailure = () => {
      if (debounce) return
      debounce = window.setTimeout(() => {
        debounce = null
        void getSession().then(session => {
          if (!session?.user) void forceRelogin()
        })
      }, 1500)
    }
    window.addEventListener('alma:auth-failure', onAuthFailure)
    return () => {
      if (debounce) window.clearTimeout(debounce)
      window.removeEventListener('alma:auth-failure', onAuthFailure)
    }
  }, [])

  if (isPublic) {
    return <>{children}</>
  }

  if (isBooting) {
    if (sessionStuck) {
      return <LoadingOverlay label="লগইন পেজে যাচ্ছি..." data-auth-gate />
    }
    if (loadingTimedOut) {
      const showForceRelogin = retryCount >= 3
      return (
        <div data-auth-gate className="fixed inset-0 z-[240] flex min-h-[100dvh] flex-col items-center justify-center gap-4 bg-bg-1 px-6 text-center">
          <p className="text-sm font-semibold text-cream">সেশন যাচাই হচ্ছে না</p>
          <p className="max-w-sm text-[11px] text-muted">
            ইন্টারনেট চেক করুন, তারপর আবার চেষ্টা করুন। বারবার সমস্যা হলে পুনরায় লগইন করুন।
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
                আবার চেষ্টা
              </Button>
            )}
            {showForceRelogin && (
              <Button variant="gold" size="sm" onClick={() => void forceRelogin()}>
                পুনরায় লগইন
              </Button>
            )}
          </div>
        </div>
      )
    }
    return <LoadingOverlay label="Alma ERP খুলছে..." data-auth-gate />
  }

  if (!isAuthed) {
    return <LoadingOverlay label="লগইন পেজে যাচ্ছি..." data-auth-gate />
  }

  const businessAccess = session?.user?.businessAccess ?? initialSession?.user?.businessAccess

  return (
    <BusinessProvider allowedBusinessAccess={businessAccess}>
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

function SessionBridge({ children, session }: { children: ReactNode; session: Session | null }) {
  return (
    <SessionProvider
      session={session}
      refetchOnWindowFocus={false}
      refetchInterval={0}
    >
      <AppBootRecovery />
      <AppReadyMarker />
      <PwaBootstrap />
      <AuthGate initialSession={session}>{children}</AuthGate>
    </SessionProvider>
  )
}

export function AppProviders({
  children,
  session,
}: {
  children: ReactNode
  session: Session | null
}) {
  return <SessionBridge session={session}>{children}</SessionBridge>
}
