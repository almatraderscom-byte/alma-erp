'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { AlmaLoader } from './AlmaLoader'

type LoadingOverlayProps = {
  label?: string
  mode?: 'screen' | 'panel'
  className?: string
}

export function LoadingOverlay({ label = 'Loading secure workspace', mode = 'screen', className = '' }: LoadingOverlayProps) {
  const reduceMotion = useReducedMotion()
  const screen = mode === 'screen'

  return (
    <motion.div
      className={[
        screen ? 'fixed inset-0 z-[240] min-h-[100dvh]' : 'min-h-[18rem] w-full',
        'flex items-center justify-center overflow-hidden bg-black text-cream',
        className,
      ].join(' ')}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.22 } }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(201,168,76,0.12),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.035),transparent_28%,rgba(201,168,76,0.035))]" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-gold-dim/30 to-transparent" />
      <AlmaLoader size={screen ? 'lg' : 'md'} label={label} className="relative z-10 px-6" />
    </motion.div>
  )
}
