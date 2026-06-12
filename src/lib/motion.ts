/** Shared motion presets — max 250ms, respect reduced motion at call sites. */

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
