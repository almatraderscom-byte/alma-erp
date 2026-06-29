'use client'

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { usePathname } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { AlmaLoader } from './AlmaLoader'

export function RouteTransitionLoader() {
  const pathname = usePathname()
  const reduceMotion = useReducedMotion()
  const previousPath = useRef(pathname)
  const firstRender = useRef(true)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      previousPath.current = pathname
      return
    }
    if (previousPath.current === pathname) return
    previousPath.current = pathname

    setVisible(true)
    const timer = window.setTimeout(() => setVisible(false), reduceMotion ? 100 : 240)
    return () => window.clearTimeout(timer)
  }, [pathname, reduceMotion])

  return (
    <AnimatePresence>
      {visible && (
        <>
          <motion.div
            className="pointer-events-none fixed inset-x-0 top-0 z-[95] h-0.5 overflow-hidden bg-[#E07A5F]/10 md:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            aria-hidden="true"
          >
            <motion.div
              className="h-full bg-gradient-to-r from-transparent via-[#E07A5F] to-transparent"
              initial={reduceMotion ? { x: '0%' } : { x: '-100%' }}
              animate={reduceMotion ? { x: '0%' } : { x: '100%' }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
            />
          </motion.div>
          <motion.div
            className="pointer-events-none fixed inset-x-0 top-0 z-[95] hidden h-[100dvh] items-center justify-center bg-card/80 backdrop-blur-[2px] md:flex"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.08 : 0.22, ease: [0.22, 1, 0.36, 1] }}
            aria-hidden="true"
          >
            <motion.div
              initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.99 }}
              transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
              className="rounded-[2rem] border border-border bg-card/88 px-10 py-8 shadow-xl shadow-black/8"
            >
              <AlmaLoader size="sm" label="Opening" />
            </motion.div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
