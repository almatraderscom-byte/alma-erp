'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Collision-safe action row for page headers.
 * - flex-wrap: never overlaps at narrow desktop widths
 * - shrink-0 children: buttons keep intrinsic width
 * - no absolute positioning
 */
export function PageActionBar({ children, className }: { children?: ReactNode; className?: string }) {
  if (children == null) return null
  return (
    <div
      className={cn(
        'page-action-bar flex w-full min-w-0 flex-wrap items-center gap-2',
        'justify-start md:justify-end md:max-w-[min(100%,36rem)] md:ml-auto',
        '[&_button]:shrink-0 [&_a]:shrink-0',
        className,
      )}
    >
      {children}
    </div>
  )
}
