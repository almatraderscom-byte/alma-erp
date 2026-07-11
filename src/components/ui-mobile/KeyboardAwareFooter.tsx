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
        // iOS 27: strong Liquid Glass bar material (src/styles/ios27.css) instead of
        // an opaque surface; hairline uses the iOS separator token.
        bordered && 'lg-material-strong border-t border-[color:var(--ios-separator)]',
        className,
      )}
      style={{
        // .lg-material-strong declares `position: relative` and ios27.css loads after
        // the Tailwind layer — pin sticky inline so the footer never loses it.
        position: 'sticky',
        // Keyboard height when open, else the home-indicator safe area.
        paddingBottom: 'max(var(--kb-inset, 0px), env(safe-area-inset-bottom, 0px))',
      }}
    >
      {children}
    </div>
  )
}
