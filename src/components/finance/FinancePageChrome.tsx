'use client'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/ui'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'

export function FinancePageChrome({
  title,
  subtitle,
  actions,
  hideDateFilter = false,
  children,
}: {
  title: string
  subtitle: string
  actions?: ReactNode
  /** Omit date presets (e.g. My desk portal — avoids layout motion shake). */
  hideDateFilter?: boolean
  children: ReactNode
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-5">
        {!hideDateFilter && <DateRangeFilter />}
        {children}
      </div>
    </>
  )
}
