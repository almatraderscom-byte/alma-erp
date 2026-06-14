'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

const PALETTE = ['#e1306c', '#3b82f6', '#22c55e', '#f59e0b', '#8b5cf6', '#06b6d4']

interface AgentThinkingIndicatorProps {
  label?: string
  mode?: 'fetching' | 'writing'
  className?: string
}

/** Colorful Claude-style thinking indicator — faster while fetching, slower while writing. */
export function AgentThinkingIndicator({
  label = 'চিন্তা করছি',
  mode = 'writing',
  className,
}: AgentThinkingIndicatorProps) {
  const dur = mode === 'fetching' ? 0.7 : 1.3
  return (
    <div className={cn('flex items-center gap-2.5 py-1', className)}>
      <div className="flex items-center gap-1" aria-hidden>
        {PALETTE.map((c, i) => (
          <motion.span
            key={i}
            className="h-2 w-2 rounded-full"
            style={{ background: c }}
            animate={{ y: [0, -6, 0], opacity: [0.3, 1, 0.3], scale: [0.8, 1.15, 0.8] }}
            transition={{ duration: dur, repeat: Infinity, ease: 'easeInOut', delay: i * (dur / PALETTE.length) }}
          />
        ))}
      </div>
      <motion.span
        className="text-[13px] font-medium text-zinc-400"
        animate={{ opacity: [0.55, 1, 0.55] }}
        transition={{ duration: dur * 1.6, repeat: Infinity, ease: 'easeInOut' }}
      >
        {label}
      </motion.span>
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
