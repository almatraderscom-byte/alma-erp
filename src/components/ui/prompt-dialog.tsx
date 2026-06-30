'use client'

import { useEffect, useRef, useState } from 'react'
import { MobileModalPortal } from '@/components/mobile/MobileModalPortal'
import { tapHaptic } from '@/lib/ui-haptics'
import { useModalSheetDrag } from '@/hooks/useModalSheetDrag'

/**
 * Themed prompt dialog — replaces the grey browser window.prompt() that breaks
 * the spell over the dark coral-glass UI. Promise-based imperative API so call
 * sites read almost like the native one:
 *
 *   const v = await promptDialog({ title: 'New stock quantity', inputMode: 'numeric' })
 *   if (v == null) return            // cancelled
 *
 * Resolves to the entered string (trimmed) on confirm, or null on cancel — the
 * same contract as window.prompt. Built on MobileModalPortal so it inherits the
 * app's modal slide-up + backdrop blur, safe-area sizing and scroll-lock. If the
 * host isn't mounted yet (very early render), it falls back to the native prompt.
 */
export type PromptOpts = {
  title?: string
  message?: string
  defaultValue?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
  /** Hint the right mobile keyboard; 'numeric'/'decimal' for money & counts. */
  inputMode?: 'text' | 'numeric' | 'decimal'
  /** Optional validator — return an error string to block submit, or null to allow. */
  validate?: (value: string) => string | null
}

type Pending = PromptOpts & { resolve: (v: string | null) => void }

let setPendingExternal: ((p: Pending | null) => void) | null = null

export function promptDialog(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => {
    if (!setPendingExternal) {
      // Host not mounted — fall back to native so the action is never lost.
      resolve(typeof window !== 'undefined' ? window.prompt(opts.message || opts.title || '', opts.defaultValue || '') : null)
      return
    }
    setPendingExternal({ ...opts, resolve })
  })
}

export function PromptDialogHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  const [value, setValue] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setPendingExternal = setPending
    return () => {
      setPendingExternal = null
    }
  }, [])

  // Seed + focus the field each time a new prompt opens.
  useEffect(() => {
    if (!pending) return
    setValue(pending.defaultValue ?? '')
    setErr(null)
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 60)
    return () => clearTimeout(t)
  }, [pending])

  // Esc cancels while open.
  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        pending.resolve(null)
        setPending(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending])

  const cancel = () => {
    if (!pending) return
    tapHaptic()
    pending.resolve(null)
    setPending(null)
  }

  const submit = () => {
    if (!pending) return
    const v = value.trim()
    const verr = pending.validate ? pending.validate(v) : null
    if (verr) {
      setErr(verr)
      return
    }
    tapHaptic()
    pending.resolve(v)
    setPending(null)
  }

  const { sheetRef, handleProps } = useModalSheetDrag(cancel)

  return (
    <MobileModalPortal
      open={!!pending}
      onBackdropClick={cancel}
      zIndex={20000}
      aria-label={pending?.title || 'Input'}
    >
      {pending && (
        <div ref={sheetRef} className="mobile-modal-shell mobile-sheet mx-auto w-full max-w-sm rounded-t-3xl border border-border-subtle bg-card p-5 sm:rounded-3xl">
          {/* Grab zone — drag down to dismiss on phones (centered dialog on ≥sm). */}
          <div {...handleProps} className="-mx-5 -mt-5 mb-1 flex justify-center px-5 pb-1 pt-3 sm:hidden">
            <span className="h-1 w-10 rounded-full bg-border-strong" />
          </div>
          {pending.title && <h2 className="mb-1.5 text-base font-bold text-cream">{pending.title}</h2>}
          {pending.message && <p className="mb-3 whitespace-pre-line text-[13px] leading-relaxed text-muted-hi">{pending.message}</p>}
          <input
            ref={inputRef}
            value={value}
            inputMode={pending.inputMode || 'text'}
            placeholder={pending.placeholder}
            onChange={(e) => {
              setValue(e.target.value)
              if (err) setErr(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
            className="w-full rounded-xl border border-border bg-bg-2 px-3 py-2.5 text-sm text-cream placeholder:text-muted focus:border-gold-dim/50 focus:outline-none"
          />
          {err && <p className="mt-1.5 text-[12px] font-semibold text-danger">{err}</p>}
          <div className="mt-5 flex gap-2">
            <button
              type="button"
              onClick={cancel}
              className="flex-1 rounded-xl border border-border-subtle py-2.5 text-sm font-semibold text-muted-hi transition-all hover:bg-bg-2 active:scale-[0.98]"
            >
              {pending.cancelLabel || 'Cancel'}
            </button>
            <button
              type="button"
              onClick={submit}
              className="flex-1 rounded-xl border border-gold/40 bg-gold/15 py-2.5 text-sm font-bold text-gold-lt transition-all hover:bg-gold/25 active:scale-[0.98]"
            >
              {pending.confirmLabel || 'OK'}
            </button>
          </div>
        </div>
      )}
    </MobileModalPortal>
  )
}
