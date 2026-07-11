'use client'

import { useEffect, useState } from 'react'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { tapHaptic, warningHaptic } from '@/lib/ui-haptics'
import { useModalSheetDrag } from '@/hooks/useModalSheetDrag'

/**
 * Themed confirm dialog — replaces the grey browser window.confirm() that breaks
 * the spell over the dark coral-glass UI. Promise-based imperative API so call
 * sites read almost like the native one:
 *
 *   if (!(await confirmDialog({ message: '…', danger: true }))) return
 *
 * Built on MobileModalPortal so it inherits the app's modal slide-up + backdrop
 * blur, safe-area sizing and scroll-lock. If the host isn't mounted yet (very
 * early render), it safely falls back to the native confirm so a guard is never
 * silently skipped.
 */
export type ConfirmOpts = {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Red destructive styling + a firmer haptic on confirm. */
  danger?: boolean
}

type Pending = ConfirmOpts & { resolve: (v: boolean) => void }

let setPendingExternal: ((p: Pending | null) => void) | null = null

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    if (!setPendingExternal) {
      // Host not mounted — never silently skip a guard.
      resolve(typeof window !== 'undefined' ? window.confirm(opts.message) : false)
      return
    }
    setPendingExternal({ ...opts, resolve })
  })
}

export function ConfirmDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null)

  useEffect(() => {
    setPendingExternal = setPending
    return () => {
      setPendingExternal = null
    }
  }, [])

  // Esc closes as cancel while open.
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pending.resolve(false)
        setPending(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  const close = (v: boolean) => {
    if (!pending) return
    if (v && pending.danger) warningHaptic()
    else tapHaptic()
    pending.resolve(v)
    setPending(null)
  }

  const { sheetRef, handleProps } = useModalSheetDrag(() => close(false))

  return (
    <MobileModalPortal
      open={!!pending}
      onBackdropClick={() => close(false)}
      zIndex={20000}
      aria-label={pending?.title || 'Confirm'}
    >
      {pending && (
        <div ref={sheetRef} className="mobile-modal-shell mobile-sheet lg-material-strong mx-auto w-full max-w-sm rounded-t-[var(--ios-radius-sheet)] p-5 sm:rounded-[var(--ios-radius-card)]">
          {/* Grab zone — drag down to dismiss on phones (centered dialog on ≥sm). */}
          <div {...handleProps} className="-mx-5 -mt-5 mb-1 flex justify-center px-5 pb-1 pt-1 sm:hidden">
            <span className="ios-grabber" />
          </div>
          {pending.title && <h2 className="mb-1.5 text-base font-bold text-cream">{pending.title}</h2>}
          <p className="whitespace-pre-line text-[13px] leading-relaxed text-muted-hi">{pending.message}</p>
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={() => close(false)}
              className="flex-1 rounded-xl border border-[var(--ios-separator)] bg-[var(--ios-fill-quaternary)] py-2.5 text-sm font-semibold text-muted-hi transition-all hover:bg-[var(--ios-fill-secondary)] active:scale-[0.98]"
            >
              {pending.cancelLabel || 'Cancel'}
            </button>
            <button
              type="button"
              onClick={() => close(true)}
              className={`flex-1 rounded-xl border py-2.5 text-sm font-bold transition-all active:scale-[0.98] ${
                pending.danger
                  ? 'border-danger/40 bg-danger/15 text-danger hover:bg-danger/25'
                  : 'border-gold/40 bg-gold/15 text-gold-lt hover:bg-gold/25'
              }`}
            >
              {pending.confirmLabel || 'Confirm'}
            </button>
          </div>
        </div>
      )}
    </MobileModalPortal>
  )
}
