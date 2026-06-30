'use client'

import { useDragControls, type PanInfo } from 'framer-motion'
import type { PointerEvent as ReactPointerEvent } from 'react'

/**
 * Finger-tracking "drag to dismiss" for bottom-sheets (framer-motion).
 *
 * The sheet follows the finger 1:1 as it's pulled DOWN (it can't be pulled up
 * past its resting position), and on release either snaps back with a spring or
 * dismisses if the pull was far/fast enough — the premium iOS-style sheet feel.
 *
 * Drag is started ONLY from the grabber handle (via `startDrag` on the handle's
 * onPointerDown), so the sheet's own scrollable content still scrolls normally.
 * Spread `motionProps` on the `motion.*` sheet element; put `startDrag` on the
 * grabber and give the grabber `touch-none` so the browser doesn't treat the
 * downward drag as a page scroll.
 *
 * Usage:
 *   const { motionProps, startDrag } = useSheetDragDismiss(() => setOpen(false))
 *   <motion.aside {...motionProps} initial={{y:'100%'}} animate={{y:0}} exit={{y:'100%'}}>
 *     <div onPointerDown={startDrag} className="touch-none …"><span className="grabber" /></div>
 *     …
 *   </motion.aside>
 */
export function useSheetDragDismiss(
  onDismiss: () => void,
  opts: { distance?: number; velocity?: number } = {},
) {
  const distance = opts.distance ?? 110
  const velocity = opts.velocity ?? 650
  const dragControls = useDragControls()

  const motionProps = {
    drag: 'y' as const,
    dragControls,
    // Drag is hand-started from the grabber only — the content area stays scrollable.
    dragListener: false,
    // Resting position is y:0; rigid against pulling up, full 1:1 follow pulling down.
    dragConstraints: { top: 0, bottom: 0 },
    dragElastic: { top: 0, bottom: 1 },
    onDragEnd: (_e: MouseEvent | TouchEvent | globalThis.PointerEvent, info: PanInfo) => {
      if (info.offset.y > distance || info.velocity.y > velocity) onDismiss()
    },
  }

  const startDrag = (e: ReactPointerEvent) => dragControls.start(e)

  return { motionProps, startDrag }
}
