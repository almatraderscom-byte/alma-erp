'use client'
import { PageHeader } from '@/components/ui'
import { BusinessSwitcherCompact } from '@/components/layout/BusinessSwitcher'
import { useBusiness } from '@/contexts/BusinessContext'

export function TradingPageShell({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  const { business } = useBusiness()
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle ?? `${business.name} · P2P operations`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <BusinessSwitcherCompact />
            {actions}
          </div>
        }
      />
      <div className="space-y-5 p-3 pb-[calc(6rem+env(safe-area-inset-bottom))] sm:p-4 md:p-8 md:pb-8">
        {children}
      </div>
    </>
  )
}
