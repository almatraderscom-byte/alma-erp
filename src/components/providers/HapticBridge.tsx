'use client'

import { useEffect } from 'react'
import { impactLight, selection } from '@/lib/haptics'

/**
 * App-wide haptic wiring — one capture-phase bridge instead of sprinkling
 * onClick haptics through every page. Gives the whole ERP + agent app the
 * iOS "everything answers your finger" feel:
 *
 * - Tap on any button / link / role=button → light impact.
 * - Toggling a checkbox/radio/select → selection tick.
 * - Typing in any input/textarea (incl. the agent composer) → keyboard-style
 *   selection tick, rate-limited in the haptics lib so bursts feel like the
 *   iOS keyboard rather than a buzz.
 *
 * Opt-out per element with `data-no-haptic` (e.g. high-frequency custom
 * controls that fire their own semantic haptics). Semantic moments (approve,
 * success, error) fire their own notify* haptics at the call site — this
 * bridge only covers the generic layer beneath them.
 */

const INTERACTIVE_SELECTOR =
  'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="switch"], summary, [data-haptic]'

function isEditableKey(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false
  return e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter'
}

export function HapticBridge() {
  useEffect(() => {
    const onClick = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target?.closest) return
      const el = target.closest(INTERACTIVE_SELECTOR)
      if (!el || el.closest('[data-no-haptic]')) return
      impactLight()
    }

    const onChange = (e: Event) => {
      const target = e.target as HTMLElement | null
      if (!target || target.closest?.('[data-no-haptic]')) return
      const tag = target.tagName
      if (
        tag === 'SELECT' ||
        (tag === 'INPUT' &&
          ['checkbox', 'radio', 'range'].includes((target as HTMLInputElement).type))
      ) {
        selection()
      }
    }

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      if (!target || target.closest?.('[data-no-haptic]')) return
      const tag = target.tagName
      const editable =
        tag === 'TEXTAREA' ||
        (tag === 'INPUT' && !['checkbox', 'radio', 'button', 'submit'].includes((target as HTMLInputElement).type)) ||
        target.isContentEditable
      if (editable && isEditableKey(e)) selection()
    }

    document.addEventListener('click', onClick, { capture: true, passive: true })
    document.addEventListener('change', onChange, { capture: true, passive: true })
    document.addEventListener('keydown', onKeyDown, { capture: true, passive: true })
    return () => {
      document.removeEventListener('click', onClick, { capture: true })
      document.removeEventListener('change', onChange, { capture: true })
      document.removeEventListener('keydown', onKeyDown, { capture: true })
    }
  }, [])

  return null
}
