/** Shared motion presets — max 250ms, respect reduced motion at call sites. */

/**
 * The single motion vocabulary for the whole app. Springs (not durations) are
 * what make transforms feel physical/premium; durations stay only for pure
 * color/opacity transitions. Pick by intent so every card, sheet and list shares
 * one "feel". Reduced motion is handled globally by <MotionConfig reducedMotion="user">.
 */
export const SPRING = {
  /** taps, presses, chips, toggles */
  snappy: { type: 'spring' as const, stiffness: 500, damping: 30 },
  /** cards, hovers, lifts */
  default: { type: 'spring' as const, stiffness: 380, damping: 30 },
  /** page / list entrance, reveals */
  gentle: { type: 'spring' as const, stiffness: 260, damping: 26, mass: 0.7 },
  /** modals / sheets */
  smooth: { type: 'spring' as const, stiffness: 300, damping: 30 },
} as const

/** The one cubic-bezier for pure color/opacity transitions (matches CSS keyframes). */
export const EASE_STANDARD = [0.22, 1, 0.36, 1] as const

/** Shared entrance geometry so every list/section enters the same way. */
export const ENTER = { y: 12, stagger: 0.05, delayChildren: 0.02 } as const

/** Count-up spring (KPI numbers). */
export const COUNT_SPRING = { stiffness: 90, damping: 20, mass: 0.8 } as const

export const MOTION = {
  page: {
    initial: { opacity: 0, y: 4 },
    animate: { opacity: 1, y: 0 },
    transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
  },
  stagger: {
    container: { staggerChildren: 0.02 },
    item: {
      initial: { opacity: 0, y: 4 },
      animate: { opacity: 1, y: 0 },
      transition: { duration: 0.18, ease: [0.22, 1, 0.36, 1] },
    },
  },
  modal: {
    spring: { type: 'spring' as const, stiffness: 300, damping: 30 },
  },
  press: { scale: 0.98 },
  countUp: { duration: 0.45, ease: [0.22, 1, 0.36, 1] },
} as const
