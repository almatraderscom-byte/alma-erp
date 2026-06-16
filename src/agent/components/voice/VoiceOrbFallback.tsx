'use client'

import { motion } from 'framer-motion'

/** Lightweight CSS orb — no WebGL. Used when Three.js is unavailable or not yet loaded. */
export default function VoiceOrbFallback({
  size = 160,
  pulsing = false,
  className = '',
}: {
  size?: number
  pulsing?: boolean
  className?: string
}) {
  return (
    <div
      className={`relative flex items-center justify-center ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <motion.div
        className="absolute rounded-full blur-3xl"
        style={{
          width: size * 1.15,
          height: size * 1.15,
          background: 'radial-gradient(circle, rgba(224,122,95,0.35) 0%, rgba(56,189,248,0.1) 55%, transparent 75%)',
        }}
        animate={pulsing ? { opacity: [0.4, 0.75, 0.4], scale: [0.92, 1.08, 0.92] } : { opacity: [0.35, 0.55, 0.35], scale: [0.95, 1.03, 0.95] }}
        transition={{ duration: pulsing ? 1.2 : 5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="relative rounded-full"
        style={{
          width: size * 0.88,
          height: size * 0.88,
          background: 'radial-gradient(circle at 35% 30%, #F6D5C8 0%, #E07A5F 45%, #c45a42 85%)',
          boxShadow: '0 8px 32px rgba(224,122,95,0.35), inset 0 -8px 24px rgba(0,0,0,0.08)',
        }}
        animate={{ scale: [1, 1.04, 1] }}
        transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  )
}
