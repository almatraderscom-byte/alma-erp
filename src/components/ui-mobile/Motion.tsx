'use client'

import { motion, type HTMLMotionProps, type Variants } from 'framer-motion'
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Shared motion vocabulary for the whole app so every page feels alive and
 * consistent. Spring-based, GPU-friendly (transform/opacity only), and it
 * inherits the global `reducedMotion="user"` from <MotionConfig> — so users who
 * ask their OS for less motion get instant, jank-free pages automatically.
 */

export const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.02 } },
}

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 260, damping: 26, mass: 0.7 } },
}

/** Wrap a section; direct <Reveal.Item> children fade+spring up in a stagger. */
export function Reveal({ children, className, ...props }: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <motion.div className={className} variants={containerVariants} initial="hidden" animate="show" {...props}>
      {children}
    </motion.div>
  )
}

/** A single staggered child of <Reveal>. */
export function RevealItem({ children, className, ...props }: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <motion.div className={className} variants={itemVariants} {...props}>
      {children}
    </motion.div>
  )
}

/**
 * A surface that lifts on hover and dips on press — the tactile, "floating"
 * feel. Use for any tappable card. Falls back to no movement under reduced
 * motion (handled globally by MotionConfig).
 */
export function Lift({ children, className, ...props }: { children: ReactNode; className?: string } & HTMLMotionProps<'div'>) {
  return (
    <motion.div
      className={cn('will-change-transform', className)}
      whileHover={{ y: -3 }}
      whileTap={{ scale: 0.985 }}
      transition={{ type: 'spring', stiffness: 380, damping: 30 }}
      {...props}
    >
      {children}
    </motion.div>
  )
}
