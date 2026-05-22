'use client'

import { useEffect, useRef } from 'react'
import { lockIosModalScroll, subscribeIosVisualViewport } from '@/lib/ios-modal-viewport'

/** Bind visualViewport + iOS-safe body/main scroll lock while a modal is open. */
export function useIosModalViewport(open: boolean) {
  const overlayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const unlock = lockIosModalScroll()
    const unsubVv = subscribeIosVisualViewport(() => {})
    return () => {
      unsubVv()
      unlock()
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const root = overlayRef.current
    if (!root) return

    function onFocusIn(event: FocusEvent) {
      const target = event.target
      if (!(target instanceof HTMLElement)) return
      if (!target.matches('input, textarea, select, [contenteditable="true"]')) return
      if (!root?.contains(target)) return
      requestAnimationFrame(() => {
        try {
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
        } catch {
          /* ignore */
        }
      })
    }

    root.addEventListener('focusin', onFocusIn)
    return () => root.removeEventListener('focusin', onFocusIn)
  }, [open])

  return overlayRef
}
