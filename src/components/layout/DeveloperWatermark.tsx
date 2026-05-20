'use client'

import { usePathname } from 'next/navigation'
import { PLATFORM_Z } from '@/lib/platform-z-index'
import { cn } from '@/lib/utils'

const PUBLIC_PREFIXES = ['/login', '/forgot-password', '/reset-password', '/invoice/share']

function useCompactBottom(): boolean {
  const pathname = usePathname() ?? ''
  return PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix))
}

/**
 * Global developer credit — fixed, non-interactive, above mobile bottom nav.
 * Mounted from root layout via GlobalPlatformChrome (never per-page).
 */
export function DeveloperWatermark() {
  const compactBottom = useCompactBottom()

  return (
    <p
      data-platform-watermark="true"
      style={{ zIndex: PLATFORM_Z.watermark }}
      className={cn(
        'developer-watermark pointer-events-none fixed right-3 select-none',
        'text-[10px] font-medium leading-none tracking-[0.14em] md:right-5 md:text-[11px]',
        'text-zinc-400/55 md:text-zinc-400/60',
        'print:hidden',
        compactBottom
          ? 'bottom-[max(0.75rem,env(safe-area-inset-bottom))]'
          : 'bottom-[calc(5.25rem+env(safe-area-inset-bottom))] md:bottom-5',
      )}
      aria-hidden="true"
    >
      Developed by{' '}
      <span className="font-semibold tracking-[0.08em] text-gold/60 md:text-gold/65">Maruf</span>
    </p>
  )
}
