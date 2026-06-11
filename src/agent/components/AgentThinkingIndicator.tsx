'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

const DOTS = [0, 1, 2]

interface AgentThinkingIndicatorProps {
  label?: string
  toolName?: string
  className?: string
}

/** Claude-inspired thinking / streaming indicator */
export function AgentThinkingIndicator({
  label = 'চিন্তা করছি',
  toolName,
  className,
}: AgentThinkingIndicatorProps) {
  return (
    <div className={cn('flex items-center gap-3 py-1', className)}>
      <div className="flex items-center gap-1.5" aria-hidden>
        {DOTS.map((i) => (
          <motion.span
            key={i}
            className="h-2 w-2 rounded-full bg-gold/80"
            animate={{ y: [0, -5, 0], opacity: [0.35, 1, 0.35] }}
            transition={{
              duration: 1.1,
              repeat: Infinity,
              ease: 'easeInOut',
              delay: i * 0.18,
            }}
          />
        ))}
      </div>
      <div className="min-w-0">
        <motion.p
          className="text-[13px] font-medium text-zinc-400"
          animate={{ opacity: [0.55, 1, 0.55] }}
          transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          {toolName ? `${label} · ${toolName}` : label}
        </motion.p>
      </div>
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
