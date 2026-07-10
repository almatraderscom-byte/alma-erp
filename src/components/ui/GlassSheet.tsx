'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { impactLight } from '@/lib/haptics'
import { cn } from '@/lib/utils'

/**
 * Floating Liquid Glass sheet — the app's premium command/detail surface,
 * modeled on Claude Code's command execution panel.
 *
 * - Glassmorphism: iOS 27 Liquid Glass material (`.lg-material-strong` in
 *   src/styles/ios27.css — frosted blur + saturate, inner light edge, and a
 *   readable near-opaque fallback where backdrop-filter is missing).
 * - Motion: spring physics (stiffness 300 / damping 30, slight mass + delay)
 *   — a weighted, deliberate rise from the bottom of the viewport to its
 *   resting spot (bottom sheet on phones, floating centered card on sm:+),
 *   never a linear snap. Exit is a quick downward glide.
 * - Performance: the blur layer is sheet-sized and compositor-promoted; the
 *   full-screen dim layer animates opacity only (see globals.css notes).
 * - A light haptic fires as the sheet lifts, so opening *feels* physical.
 *
 * Reusable anywhere (ERP + agent): pass any content; the shell handles
 * portal, iOS visual-viewport sizing, backdrop tap-to-close and motion.
 */

const GLASS_SPRING = {
  type: 'spring' as const,
  stiffness: 300,
  damping: 30,
  mass: 1.05,
  delay: 0.05,
}

export function GlassSheet({
  open,
  onClose,
  ariaLabel,
  className,
  children,
}: {
  open: boolean
  onClose: () => void
  ariaLabel: string
  /** Extra classes for the panel (e.g. width caps). Defaults keep max-w-lg. */
  className?: string
  children: ReactNode
}) {
  const reduceMotion = useReducedMotion()
  // Keep the portal mounted until the exit animation finishes.
  const [present, setPresent] = useState(open)

  useEffect(() => {
    if (open) {
      setPresent(true)
      impactLight()
    }
  }, [open])

  return (
    <MobileModalPortal
      open={present}
      aria-label={ariaLabel}
      onBackdropClick={onClose}
      className="alma-glass-portal"
      backdropClassName="alma-glass-backdrop"
    >
      <AnimatePresence onExitComplete={() => setPresent(false)}>
        {open && (
          <motion.div
            className={cn(
              'alma-glass-shell lg-material-strong w-full max-w-lg rounded-t-[var(--ios-radius-sheet)] sm:rounded-[var(--ios-radius-card)]',
              className,
            )}
            initial={reduceMotion ? { opacity: 0 } : { y: 560, opacity: 0.55, scale: 0.985 }}
            animate={reduceMotion ? { opacity: 1 } : { y: 0, opacity: 1, scale: 1 }}
            exit={
              reduceMotion
                ? { opacity: 0, transition: { duration: 0.12 } }
                : { y: 480, opacity: 0, transition: { duration: 0.22, ease: [0.4, 0, 1, 1] } }
            }
            transition={reduceMotion ? { duration: 0.16 } : GLASS_SPRING}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </MobileModalPortal>
  )
}

/** The iOS grab-handle row for the top of a GlassSheet. */
export function GlassSheetGrip() {
  return (
    <div className="flex shrink-0 justify-center pt-1">
      <span className="ios-grabber" aria-hidden />
    </div>
  )
}
