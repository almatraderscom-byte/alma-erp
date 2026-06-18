import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Constrains content width and applies consistent horizontal padding so pages
 * don't each invent their own gutters. Mobile-first: full-bleed with 16px
 * gutters on phones, capped width and centered from `sm` up.
 */
export function Container({
  children,
  className,
  size = 'md',
}: {
  children: ReactNode
  className?: string
  /** Max content width. `full` opts out of the cap (e.g. wide data tables). */
  size?: 'sm' | 'md' | 'lg' | 'full'
}) {
  const widths = {
    sm: 'max-w-screen-sm',
    md: 'max-w-screen-md',
    lg: 'max-w-screen-lg',
    full: 'max-w-none',
  }
  return (
    <div className={cn('mx-auto w-full px-4 sm:px-6', widths[size], className)}>
      {children}
    </div>
  )
}
