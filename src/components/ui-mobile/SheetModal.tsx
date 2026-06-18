'use client'

import type { ReactNode } from 'react'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { cn } from '@/lib/utils'

/**
 * Bottom-sheet modal. Slides up from the bottom on phones (rounded top, grab
 * handle), centers as a dialog from `sm` up. Built on the existing
 * `MobileModalPortal`, so it inherits iOS visualViewport sizing + scroll lock.
 *
 * Safe-area + keyboard aware: the footer clears both the home indicator and the
 * on-screen keyboard via `--kb-inset` (kept in sync by GlobalKeyboardManager).
 */
export function SheetModal({
  open,
  onClose,
  title,
  children,
  footer,
  className,
  zIndex,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  /** Sticky action bar; stays above the keyboard. */
  footer?: ReactNode
  className?: string
  zIndex?: number
}) {
  return (
    <MobileModalPortal open={open} onBackdropClick={onClose} zIndex={zIndex} aria-label={typeof title === 'string' ? title : 'Dialog'}>
      <div
        className={cn(
          'mobile-modal-shell w-full bg-card',
          // Bottom sheet on phone, centered card from sm up.
          'rounded-t-3xl sm:max-w-lg sm:rounded-3xl',
          className,
        )}
      >
        {/* Grab handle (phone only) */}
        <div className="mobile-modal-header flex flex-col items-center pt-2 sm:pt-0">
          <span className="h-1 w-10 rounded-full bg-black/[0.12] sm:hidden" aria-hidden />
          {title != null && (
            <div className="flex w-full items-center justify-between px-5 py-3">
              <h2 className="text-[16px] font-bold text-cream">{title}</h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                className="-mr-2 flex h-9 w-9 items-center justify-center rounded-full text-slate-400 active:scale-95 active:bg-black/[0.05]"
              >
                ✕
              </button>
            </div>
          )}
        </div>

        <div className="mobile-modal-body px-5 pb-4">{children}</div>

        {footer != null && (
          <div
            className="mobile-modal-footer px-5 pt-3"
            style={{ paddingBottom: 'max(1rem, var(--kb-inset, 0px), env(safe-area-inset-bottom, 0px))' }}
          >
            {footer}
          </div>
        )}
      </div>
    </MobileModalPortal>
  )
}
