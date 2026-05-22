'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useIosModalViewport } from '@/hooks/useIosModalViewport'
import { cn } from '@/lib/utils'

type Props = {
  open: boolean
  children: ReactNode
  zIndex?: number
  className?: string
  backdropClassName?: string
  onBackdropClick?: () => void
  'aria-label'?: string
}

/**
 * Portal modals to document.body with iOS visualViewport sizing.
 * Fixes: fixed-in-overflow-main clipping, keyboard overlap, body scroll bleed.
 */
export function MobileModalPortal({
  open,
  children,
  zIndex = 10000,
  className,
  backdropClassName,
  onBackdropClick,
  'aria-label': ariaLabel,
}: Props) {
  const [mounted, setMounted] = useState(false)
  const overlayRef = useIosModalViewport(open)

  useEffect(() => setMounted(true), [])

  if (!mounted || !open) return null

  return createPortal(
    <div
      ref={overlayRef}
      className={cn('mobile-modal-overlay', className)}
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
    >
      {onBackdropClick ? (
        <button
          type="button"
          aria-label="Close dialog"
          className={cn('mobile-modal-backdrop', backdropClassName)}
          onClick={onBackdropClick}
        />
      ) : null}
      <div className="mobile-modal-overlay-inner">{children}</div>
    </div>,
    document.body,
  )
}
