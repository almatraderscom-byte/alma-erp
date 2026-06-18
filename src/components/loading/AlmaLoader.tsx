'use client'

import { motion, useReducedMotion } from 'framer-motion'

type AlmaLoaderProps = {
  size?: 'sm' | 'md' | 'lg'
  label?: string
  className?: string
}

const LETTERS = ['A', 'L', 'M', 'A']

const SIZE_CLASS = {
  sm: 'text-2xl sm:text-3xl tracking-[0.28em]',
  md: 'text-4xl sm:text-5xl tracking-[0.32em]',
  lg: 'text-5xl sm:text-7xl tracking-[0.34em]',
}

export function AlmaLoader({ size = 'md', label = 'Loading secure workspace', className = '' }: AlmaLoaderProps) {
  const reduceMotion = useReducedMotion()

  return (
    <div className={`relative flex flex-col items-center justify-center text-center ${className}`} role="status" aria-live="polite">
      <motion.div
        className="relative"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.985, filter: 'blur(6px)' }}
        animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: [0.985, 1, 0.995], filter: 'blur(0px)' }}
        transition={reduceMotion ? { duration: 0 } : { duration: 1.25, ease: [0.22, 1, 0.36, 1], repeat: Infinity, repeatDelay: 1.2 }}
      >
        <div className="pointer-events-none absolute inset-x-2 top-1/2 h-10 -translate-y-1/2 rounded-full bg-[#8b7cf6]/12 blur-2xl" />
        <div className="relative overflow-hidden px-1 py-2">
          <motion.div
            className="alma-neon-wordmark flex items-center justify-center pl-[0.34em] font-serif font-semibold leading-none"
            aria-label="ALMA"
          >
            {LETTERS.map((letter, index) => (
              <motion.span
                key={`${letter}-${index}`}
                className={`${SIZE_CLASS[size]} inline-block will-change-transform`}
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                transition={{ duration: 0.62, delay: 0.1 + index * 0.09, ease: [0.22, 1, 0.36, 1] }}
              >
                {letter}
              </motion.span>
            ))}
          </motion.div>
          {!reduceMotion && <span className="alma-shimmer-sweep" aria-hidden="true" />}
        </div>
      </motion.div>

      <motion.div
        className="mt-4 h-px w-24 overflow-hidden rounded-full bg-[#8b7cf6]/15"
        initial={reduceMotion ? false : { opacity: 0, width: 48 }}
        animate={reduceMotion ? { opacity: 0.7 } : { opacity: [0.35, 0.9, 0.35], width: [56, 112, 72] }}
        transition={reduceMotion ? { duration: 0 } : { duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
      >
        <div className="h-full w-full bg-gradient-to-r from-transparent via-[#8b7cf6] to-transparent" />
      </motion.div>

      {label && (
        <motion.p
          className="mt-3 text-[10px] font-semibold uppercase tracking-[0.22em] text-muted"
          initial={reduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.45, delay: 0.4 }}
        >
          {label}
        </motion.p>
      )}
    </div>
  )
}
