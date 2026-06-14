'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

const SPOKES = 12
const PALETTE = ['#e1306c', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#06b6d4']

interface AgentThinkingIndicatorProps {
  label?: string
  mode?: 'fetching' | 'writing' | 'settled'
  className?: string
}

/** Claude-style starburst spinner — spins while working, settles with "ALMA" when done. */
export function AgentThinkingIndicator({
  label = 'চিন্তা করছি',
  mode = 'writing',
  className,
}: AgentThinkingIndicatorProps) {
  const isSettled = mode === 'settled'
  const spinDur = mode === 'fetching' ? 1.4 : 2.6

  return (
    <div className={cn('flex items-center gap-2.5 py-1', className)}>
      {/* Starburst */}
      <motion.div
        className="relative h-6 w-6 shrink-0"
        animate={isSettled ? { rotate: 0 } : { rotate: 360 }}
        transition={isSettled
          ? { duration: 0.4, ease: 'easeOut' }
          : { duration: spinDur, repeat: Infinity, ease: 'linear' }
        }
        aria-hidden
      >
        {Array.from({ length: SPOKES }).map((_, i) => {
          const angle = (360 / SPOKES) * i
          const color = PALETTE[i % PALETTE.length]
          return (
            <motion.span
              key={i}
              className="absolute left-1/2 top-1/2 h-[9px] w-[2.5px] origin-bottom rounded-full"
              style={{
                background: color,
                transform: `translate(-50%, -100%) rotate(${angle}deg)`,
                transformOrigin: '50% 100%',
              }}
              animate={isSettled
                ? { opacity: 0.85, scaleY: 1 }
                : { opacity: [0.3, 1, 0.3], scaleY: [0.7, 1.1, 0.7] }
              }
              transition={isSettled
                ? { duration: 0.3 }
                : { duration: spinDur * 0.7, repeat: Infinity, ease: 'easeInOut', delay: i * (spinDur * 0.7 / SPOKES) }
              }
            />
          )
        })}
      </motion.div>

      {/* Label or "ALMA" text on settle */}
      {isSettled ? (
        <motion.span
          className="text-[14px] font-bold tracking-wide"
          style={{ color: PALETTE[0] }}
          initial={{ opacity: 0, x: -6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
        >
          ALMA
        </motion.span>
      ) : (
        <motion.span
          className="text-[13px] font-medium text-zinc-400"
          animate={{ opacity: [0.55, 1, 0.55] }}
          transition={{ duration: spinDur * 0.8, repeat: Infinity, ease: 'easeInOut' }}
        >
          {label}
        </motion.span>
      )}
    </div>
  )
}

/** Shimmer bars while a conversation loads */
export function AgentConversationSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-8">
      <div className="flex justify-end">
        <div className="skeleton h-12 w-[62%] rounded-2xl rounded-br-md" />
      </div>
      <div className="flex justify-start">
        <div className="space-y-2.5 w-[78%]">
          <div className="skeleton h-3.5 w-full rounded-md" />
          <div className="skeleton h-3.5 w-[92%] rounded-md" />
          <div className="skeleton h-3.5 w-[70%] rounded-md" />
        </div>
      </div>
      <div className="flex justify-end">
        <div className="skeleton h-10 w-[48%] rounded-2xl rounded-br-md" />
      </div>
    </div>
  )
}
