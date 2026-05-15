'use client'
import type { ReactNode } from 'react'
import { PageHeader } from '@/components/ui'
import { DateRangeFilter } from '@/components/date-filter/DateRangeFilter'

export function FinancePageChrome({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string
  subtitle: string
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <>
      <PageHeader title={title} subtitle={subtitle} actions={actions} />
      <div className="p-4 md:p-6 pb-24 md:pb-6 space-y-5">
        <DateRangeFilter />
        {children}
      </div>
    </>
  )
}
