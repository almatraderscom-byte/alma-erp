'use client'
import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type { Session } from 'next-auth'
import { SessionProvider, useSession } from 'next-auth/react'
import { usePathname } from 'next/navigation'
import { BusinessProvider } from '@/contexts/BusinessContext'
import { ActorProvider } from '@/contexts/ActorContext'
import { BrandingProvider } from '@/contexts/BrandingContext'
import { BrandingHead } from '@/components/branding/BrandingHead'
import { DateRangeProvider } from '@/contexts/DateRangeContext'
import { OrdersDataProvider } from '@/contexts/OrdersDataContext'
import { Sidebar, MobileNav } from '@/components/layout/Sidebar'
import { MobileBottomSpacer } from '@/components/layout/MobileNavChrome'
import { PwaBootstrap } from '@/components/providers/PwaBootstrap'

const NotificationCenter = dynamic(
  () => import('@/components/notifications/NotificationCenter').then(mod => mod.NotificationCenter),
  { ssr: false },
)

function ErpChrome({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="flex h-[100dvh] w-full overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto min-w-0 scrollbar-hide">
          {children}
          <MobileBottomSpacer />
        </main>
      </div>
      <MobileNav />
      <NotificationCenter />
    </>
  )
}

function AuthGate({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const { data: session, status } = useSession()

  const isPublic =
    pathname.startsWith('/login')
    || pathname.startsWith('/forgot-password')
    || pathname.startsWith('/reset-password')

  if (isPublic) {
    return <>{children}</>
  }

  if (status === 'loading') {
    return (
      <div className="min-h-[100dvh] flex items-center justify-center bg-black text-zinc-500 text-sm">
        Authenticating…
      </div>
    )
  }

  if (status === 'unauthenticated') {
    return <>{children}</>
  }

  return (
    <BusinessProvider allowedBusinessAccess={session?.user?.businessAccess}>
      <ActorProvider>
        <BrandingProvider>
          <BrandingHead />
          <DateRangeProvider>
            <OrdersDataProvider>
              <ErpChrome>{children}</ErpChrome>
            </OrdersDataProvider>
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
