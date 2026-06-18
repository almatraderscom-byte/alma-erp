'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { KeyboardAwareFooter } from './KeyboardAwareFooter'

/**
 * The one shared screen scaffold. Every page renders inside it so headers are
 * never under the notch, footers are never under the home indicator, and the
 * scroll region behaves consistently.
 *
 * Layout (top → bottom):
 *   ┌─ header  (optional, sticky, safe-top + safe-x)
 *   ├─ scroll  (flex-1, safe-x, your page content)
 *   └─ footer  (optional, KeyboardAwareFooter — stays above the keyboard)
 *
 * STEP 3 of the mobile foundation: combines `.safe-top` / `.safe-x`, the scroll
 * container, and the keyboard-aware footer in one place.
 */
export function MobileScreen({
  header,
  footer,
  children,
  className,
  contentClassName,
  scrollRef,
}: {
  header?: ReactNode
  /** Rendered inside a <KeyboardAwareFooter>; stays above the keyboard. */
  footer?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
  scrollRef?: React.Ref<HTMLDivElement>
}) {
  return (
    <div className={cn('flex min-h-[100dvh] flex-col bg-bg-0', className)}>
      {header != null && (
        <div className="safe-top safe-x sticky top-0 z-20 shrink-0">{header}</div>
      )}

      <div
        ref={scrollRef}
        className={cn(
          'safe-x scrollbar-hide min-h-0 flex-1 overflow-y-auto overscroll-y-contain',
          contentClassName,
        )}
        style={{ WebkitOverflowScrolling: 'touch' }}
      >
        {children}
      </div>

      {footer != null && <KeyboardAwareFooter>{footer}</KeyboardAwareFooter>}
    </div>
  )
}
