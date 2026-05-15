'use client'
import { Sidebar, MobileNav } from '@/components/layout/Sidebar'
import { MobileBottomSpacer } from '@/components/layout/MobileNavChrome'
import { AppProviders } from '@/components/providers/AppProviders'

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProviders>
      <div className="flex h-[100dvh] w-full overflow-hidden">
        <Sidebar />
        <main className="flex-1 overflow-y-auto min-w-0 scrollbar-hide">
          {children}
          <MobileBottomSpacer />
        </main>
      </div>
      <MobileNav />
    </AppProviders>
  )
}
