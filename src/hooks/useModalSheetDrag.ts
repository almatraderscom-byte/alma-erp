'use client'

import { useCallback, useRef } from 'react'

/**
 * Finger drag-to-dismiss for the CSS-shell bottom sheets (MobileModalPortal /
 * `.mobile-modal-shell`). These are NOT framer-motion (that's useSheetDragDismiss),
 * so this is a small vanilla pointer implementation that plays nice with the CSS
 * slide-up entrance:
 *
 *  - Phone only. On ≥640px the shell is a centered dialog, not a sheet → no drag.
 *  - Drag starts ONLY from the grab handle (spread `handleProps` on it) so the
 *    sheet's own scrollable content keeps scrolling.
 *  - On drag start it clears the shell's CSS `animation` (the slide-up has long
 *    finished by the time a user grabs it) so the inline `transform` we set during
 *    the drag actually applies — otherwise the animation's filled end-state wins.
 *  - Past the distance/velocity threshold on release → `onClose`; otherwise the
 *    sheet springs back to rest.
 *
 * Usage:
 *   const { sheetRef, handleProps } = useModalSheetDrag(onClose)
 *   <div ref={sheetRef} className="mobile-modal-shell …">
 *     <div {...handleProps}><span className="grabber" /></div>
 *     …
 *   </div>
 */
export function useModalSheetDrag(
  onClose: () => void,
  opts: { distance?: number; velocity?: number } = {},
) {
  const distance = opts.distance ?? 90
  const velocity = opts.velocity ?? 0.5 // px per ms
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ startY: number; lastY: number; lastT: number; cur: number; v: number; active: boolean } | null>(null)

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const sheet = sheetRef.current
    if (!sheet) return
    // Centered dialog (≥sm) isn't a draggable sheet.
    if (typeof window !== 'undefined' && window.matchMedia('(min-width: 640px)').matches) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    const now = e.timeStamp
    drag.current = { startY: e.clientY, lastY: e.clientY, lastT: now, cur: 0, v: 0, active: true }
    sheet.style.animation = 'none' // release the CSS entrance so inline transform applies
    sheet.style.transition = 'none'
    sheet.style.willChange = 'transform'
    try {
      ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }, [])

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = drag.current
    const sheet = sheetRef.current
    if (!d?.active || !sheet) return
    const dy = Math.max(0, e.clientY - d.startY)
    const dt = e.timeStamp - d.lastT
    if (dt > 0) d.v = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    d.cur = dy
    sheet.style.transform = `translateY(${dy}px)`
  }, [])

  const endDrag = useCallback(() => {
    const d = drag.current
    const sheet = sheetRef.current
    if (!d?.active || !sheet) return
    d.active = false
    sheet.style.willChange = ''
    if (d.cur > distance || d.v > velocity) {
      onClose()
      return
    }
    // Spring back to rest.
    sheet.style.transition = 'transform 0.24s cubic-bezier(0.22, 1, 0.36, 1)'
    sheet.style.transform = 'translateY(0)'
  }, [onClose, distance, velocity])

  const handleProps = {
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
    style: { touchAction: 'none' as const, cursor: 'grab' as const },
  }

  return { sheetRef, handleProps }
}
