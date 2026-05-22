'use client'
import { useEffect, useRef, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type { Session } from 'next-auth'
import { SessionProvider, useSession } from 'next-auth/react'
import { usePathname, useRouter } from 'next/navigation'
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

function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const { data: session, status } = useSession()

  const isPublic =
    pathname.startsWith('/login')
    || pathname.startsWith('/forgot-password')
    || pathname.startsWith('/reset-password')

  if (isPublic) {
    return <>{children}</>
  }

  if (status === 'loading') {
    return <LoadingOverlay label="Authenticating" />
  }

  if (status === 'unauthenticated') {
    if (typeof window !== 'undefined') {
      router.replace(`/login?callbackUrl=${encodeURIComponent(pathname)}`)
    }
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
