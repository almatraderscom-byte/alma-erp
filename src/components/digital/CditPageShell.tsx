'use client'
import { PageHeader } from '@/components/ui'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'
import { BusinessSwitcherCompact } from '@/components/layout/BusinessSwitcher'
import { useBusiness } from '@/contexts/BusinessContext'
import { useBranding } from '@/contexts/BrandingContext'

export function CditPageShell({
  title,
  subtitle,
  actions,
  children,
  showDateFilter,
}: {
  title: string
  subtitle?: string
  actions?: React.ReactNode
  children: React.ReactNode
  showDateFilter?: boolean
}) {
  const { business } = useBusiness()
  const { branding } = useBranding()
  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle ?? branding?.company_name ?? business.name}
        actions={
          <div className="flex items-center gap-2">
            <BusinessSwitcherCompact />
            {actions}
          </div>
        }
      />
      <div className="p-4 md:p-8 space-y-5 pb-24 md:pb-8">
        {showDateFilter && <DateRangeFilter />}
        {children}
      </div>
    </>
  )
}
