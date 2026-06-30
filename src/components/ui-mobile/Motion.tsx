'use client'

import { motion, useInView, useReducedMotion, useSpring, type HTMLMotionProps, type Variants } from 'framer-motion'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { tapHaptic } from '@/lib/ui-haptics'
import { SPRING, ENTER, COUNT_SPRING } from '@/lib/motion'

/**
 * Shared motion vocabulary for the whole app so every page feels alive and
 * consistent. Spring-based, GPU-friendly (transform/opacity only), and it
 * inherits the global `reducedMotion="user"` from <MotionConfig> — so users who
 * ask their OS for less motion get instant, jank-free pages automatically.
 */

export const containerVariants: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: ENTER.stagger, delayChildren: ENTER.delayChildren } },
}

export const itemVariants: Variants = {
  hidden: { opacity: 0, y: ENTER.y },
  show: { opacity: 1, y: 0, transition: SPRING.gentle },
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
      transition={SPRING.default}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/**
 * Press — tactile tap feedback for buttons/chips/icon controls. Dips slightly on
 * press, no hover lift (use <Lift> for cards). Reduced-motion safe via MotionConfig.
 */
export function Press({ children, className, onPointerDown, ...props }: { children: ReactNode; className?: string } & HTMLMotionProps<'button'>) {
  return (
    <motion.button
      className={cn('will-change-transform', className)}
      whileTap={{ scale: 0.96 }}
      transition={SPRING.snappy}
      onPointerDown={(e) => { tapHaptic(); onPointerDown?.(e) }}
      {...props}
    >
      {children}
    </motion.button>
  )
}

/**
 * AppearOnScroll — fades + springs its child up the first time it scrolls into
 * view. No-op (renders statically) under reduced motion. Wrap any below-the-fold
 * section/card to give the page a living, native feel as the owner scrolls.
 */
export function AppearOnScroll({
  children,
  className,
  delay = 0,
  y = 16,
  ...props
}: { children: ReactNode; className?: string; delay?: number; y?: number } & HTMLMotionProps<'div'>) {
  const ref = useRef<HTMLDivElement>(null)
  const inView = useInView(ref, { once: true, margin: '0px 0px -10% 0px' })
  const reduce = useReducedMotion()
  if (reduce) {
    return (
      <div ref={ref} className={className}>
        {children}
      </div>
    )
  }
  return (
    <motion.div
      ref={ref}
      className={className}
      initial={{ opacity: 0, y }}
      animate={inView ? { opacity: 1, y: 0 } : { opacity: 0, y }}
      transition={{ ...SPRING.gentle, delay }}
      {...props}
    >
      {children}
    </motion.div>
  )
}

/**
 * CountUp — animates a whole number from 0 → value with a spring, then renders
 * the formatted result. Whole-integer only (money/counts); never fractional taka.
 * Under reduced motion it shows the final value immediately.
 */
export function CountUp({
  value,
  format,
  className,
}: {
  value: number
  /** Optional formatter (e.g. thousands separator). Defaults to locale string. */
  format?: (n: number) => string
  className?: string
}) {
  const reduce = useReducedMotion()
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString('en-US'))
  const spring = useSpring(reduce ? value : 0, COUNT_SPRING)
  const [display, setDisplay] = useState(reduce ? value : 0)

  useEffect(() => {
    if (reduce) {
      setDisplay(value)
      return
    }
    spring.set(value)
    const unsub = spring.on('change', v => setDisplay(Math.round(v)))
    return () => unsub()
  }, [value, reduce, spring])

  return <span className={cn('tabular-nums', className)}>{fmt(display)}</span>
}
