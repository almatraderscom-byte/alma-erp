'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface AgentSparkleLoaderProps {
  label?: string
  size?: 'sm' | 'md' | 'lg'
  className?: string
}

const SIZE = { sm: 28, md: 40, lg: 52 } as const

/**
 * Claude-inspired sparkle loader — soft coral starburst with gentle rotation + shimmer.
 */
export default function AgentSparkleLoader({
  label,
  size = 'md',
  className,
}: AgentSparkleLoaderProps) {
  const px = SIZE[size]

  return (
    <div className={cn('flex flex-col items-center gap-3', className)} role="status" aria-live="polite">
      <motion.div
        className="relative flex items-center justify-center"
        style={{ width: px, height: px }}
        animate={{ rotate: [0, 8, -6, 0] }}
        transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
      >
        <motion.svg
          viewBox="0 0 48 48"
          fill="none"
          className="h-full w-full"
          animate={{ scale: [1, 1.06, 0.97, 1] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          {/* Core glow */}
          <motion.circle
            cx="24"
            cy="24"
            r="4"
            fill="#E8846A"
            animate={{ opacity: [0.5, 1, 0.5], r: [3.5, 4.5, 3.5] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
          />
          {/* 12 rays — staggered shimmer */}
          {Array.from({ length: 12 }).map((_, i) => {
            const angle = (i * 30 * Math.PI) / 180
            const x2 = 24 + Math.cos(angle) * 20
            const y2 = 24 + Math.sin(angle) * 20
            const long = i % 3 === 0
            return (
              <motion.line
                key={i}
                x1="24"
                y1="24"
                x2={x2}
                y2={y2}
                stroke="#E8846A"
                strokeWidth={long ? 2.2 : 1.4}
                strokeLinecap="round"
                animate={{ opacity: [0.25, 0.95, 0.25] }}
                transition={{
                  duration: 1.4,
                  repeat: Infinity,
                  ease: 'easeInOut',
                  delay: i * 0.1,
                }}
              />
            )
          })}
        </motion.svg>
        {/* Outer pulse ring */}
        <motion.span
          className="pointer-events-none absolute inset-0 rounded-full"
          style={{ boxShadow: '0 0 24px rgba(232, 132, 106, 0.35)' }}
          animate={{ opacity: [0.2, 0.55, 0.2], scale: [0.85, 1.15, 0.85] }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />
      </motion.div>

      {label && (
        <motion.p
          className="text-center text-xs font-medium text-zinc-400"
          animate={{ opacity: [0.45, 0.9, 0.45] }}
          transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        >
          {label}
        </motion.p>
      )}
    </div>
  )
}
