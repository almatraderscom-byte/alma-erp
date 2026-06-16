'use client'

import { motion, useReducedMotion } from 'framer-motion'
import { AlmaLoader } from './AlmaLoader'

type LoadingOverlayProps = {
  label?: string
  mode?: 'screen' | 'panel'
  className?: string
  'data-auth-gate'?: boolean
}

export function LoadingOverlay({
  label = 'Loading secure workspace',
  mode = 'screen',
  className = '',
  'data-auth-gate': dataAuthGate,
}: LoadingOverlayProps) {
  const reduceMotion = useReducedMotion()
  const screen = mode === 'screen'

  return (
    <motion.div
      data-auth-gate={dataAuthGate ? true : undefined}
      className={[
        screen ? 'fixed inset-0 z-[240] min-h-[100dvh]' : 'min-h-[18rem] w-full',
        'flex items-center justify-center overflow-hidden bg-[#FAF9F6] text-[#1a1a2e]',
        className,
      ].join(' ')}
      initial={reduceMotion ? false : { opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={reduceMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.22 } }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,rgba(224,122,95,0.06),transparent_34%),linear-gradient(180deg,rgba(129,178,154,0.03),transparent_28%,rgba(224,122,95,0.02))]" />
      <div className="absolute inset-x-0 top-1/2 h-px bg-gradient-to-r from-transparent via-[#E07A5F]/15 to-transparent" />
      <AlmaLoader size={screen ? 'lg' : 'md'} label={label} className="relative z-10 px-6" />
    </motion.div>
  )
}
