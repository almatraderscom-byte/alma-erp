'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * A sticky footer (composer, form action bar, search) that stays ABOVE the
 * on-screen keyboard. It adds `var(--kb-inset)` to its bottom padding, which the
 * `GlobalKeyboardManager` keeps in sync with the real keyboard height.
 *
 * When the keyboard is closed it falls back to the bottom safe-area inset so the
 * footer never sits under the iPhone home indicator.
 *
 * Use this for every input that lives at the bottom of a screen so the
 * "input hidden behind keyboard" bug is fixed once, not per page.
 */
export function KeyboardAwareFooter({
  children,
  className,
  bordered = true,
}: {
  children: ReactNode
  className?: string
  /** Top hairline + surface background (default). Set false for transparent. */
  bordered?: boolean
}) {
  return (
    <div
      className={cn(
        'sticky bottom-0 z-30',
        bordered && 'border-t border-black/[0.06] bg-white/95 backdrop-blur',
        className,
      )}
      style={{
        // Keyboard height when open, else the home-indicator safe area.
        paddingBottom: 'max(var(--kb-inset, 0px), env(safe-area-inset-bottom, 0px))',
      }}
    >
      {children}
    </div>
  )
}
