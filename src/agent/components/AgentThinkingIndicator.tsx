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
    <div className={cn('flex items-center gap-2.5', className)}>
      {/* Animated dots */}
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="h-1.5 w-1.5 rounded-full bg-gold/50"
            animate={{
              scale: [1, 1.4, 1],
              opacity: [0.4, 1, 0.4],
            }}
            transition={{
              duration: mode === 'fetching' ? 0.8 : 1.2,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: i * 0.15,
            }}
          />
        ))}
      </div>
      <motion.span
        className="text-[13px] text-white/40"
        animate={{ opacity: [0.5, 0.9, 0.5] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
      >
        {label}
      </motion.span>
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
