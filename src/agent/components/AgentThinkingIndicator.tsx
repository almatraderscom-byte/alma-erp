'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

interface AgentThinkingIndicatorProps {
  label?: string
  mode?: 'fetching' | 'writing' | 'settled'
  className?: string
}

export function AgentThinkingIndicator({
  label = 'চিন্তা করছি',
  mode = 'writing',
  className,
}: AgentThinkingIndicatorProps) {
  if (mode === 'settled') return null

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* Calm sparkle — soft coral pulse (no bounce). */}
      <motion.span
        aria-hidden
        className="inline-block h-2 w-2 shrink-0 rounded-full bg-[#E07A5F]"
        animate={{ scale: [1, 1.35, 1], opacity: [0.45, 1, 0.45] }}
        transition={{
          duration: mode === 'fetching' ? 1 : 1.3,
          repeat: Infinity,
          ease: 'easeInOut',
        }}
      />
      {/* Claude-style shimmering status text. */}
      <span className="alma-thinking-shimmer text-[13px] font-medium">{label}</span>
    </div>
  )
}

export function AgentConversationSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-4 py-8 md:px-6">
      <div className="flex justify-end">
        <div className="skeleton h-10 w-[55%] rounded-2xl rounded-br-sm" />
      </div>
      <div className="space-y-2.5 w-[80%]">
        <div className="skeleton h-3 w-full rounded-md" />
        <div className="skeleton h-3 w-[90%] rounded-md" />
        <div className="skeleton h-3 w-[65%] rounded-md" />
      </div>
      <div className="flex justify-end">
        <div className="skeleton h-8 w-[40%] rounded-2xl rounded-br-sm" />
      </div>
      <div className="space-y-2.5 w-[75%]">
        <div className="skeleton h-3 w-full rounded-md" />
        <div className="skeleton h-3 w-[85%] rounded-md" />
      </div>
    </div>
  )
}
