'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * Per-model / per-role loading identity. Lets the owner tell at a glance who is
 * working: the Claude head (Claude-Code-style rotating sparkle), a Qwen worker
 * (breathing orb glow), or a DeepSeek worker (cascading data dots).
 */
export type ModelVariant = 'claude' | 'qwen' | 'deepseek' | 'default'

export function ModelSpinner({
  variant = 'default',
  size = 14,
}: {
  variant?: ModelVariant
  size?: number
}) {
  // Claude (head) — Claude-Code-style rotating, pulsing sparkle/asterisk.
  if (variant === 'claude') {
    return (
      <motion.svg
        width={size + 2}
        height={size + 2}
        viewBox="0 0 24 24"
        className="shrink-0"
        aria-hidden
        animate={{ rotate: 360 }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'linear' }}
      >
        <motion.g
          stroke="#E07A5F"
          strokeWidth="2.2"
          strokeLinecap="round"
          animate={{ opacity: [0.45, 1, 0.45] }}
          transition={{ duration: 1.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          <path d="M12 3v18" />
          <path d="M3 12h18" />
          <path d="M5.6 5.6l12.8 12.8" />
          <path d="M18.4 5.6L5.6 18.4" />
        </motion.g>
      </motion.svg>
    )
  }

  // Qwen (CS / marketer) — breathing orb glow.
  if (variant === 'qwen') {
    return (
      <span className="relative inline-block shrink-0" style={{ height: size, width: size }} aria-hidden>
        <motion.span
          className="absolute inset-0 rounded-full bg-teal-400"
          animate={{ scale: [1, 1.7, 1], opacity: [0.6, 0, 0.6] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        />
        <motion.span
          className="absolute rounded-full bg-teal-400"
          style={{ inset: size * 0.22 }}
          animate={{ opacity: [0.8, 1, 0.8] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: 'easeInOut' }}
        />
      </span>
    )
  }

  // DeepSeek — cascading data dots (cool blue), techy + distinct.
  if (variant === 'deepseek') {
    return (
      <span className="flex shrink-0 items-center gap-[3px]" aria-hidden>
        {[0, 1, 2].map((i) => (
          <motion.span
            key={i}
            className="rounded-full bg-sky-400"
            style={{ height: size * 0.4, width: size * 0.4 }}
            animate={{ opacity: [0.3, 1, 0.3], y: [0, -size * 0.22, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: i * 0.15, ease: 'easeInOut' }}
          />
        ))}
      </span>
    )
  }

  // Default — calm coral pulse (legacy look).
  return (
    <motion.span
      aria-hidden
      className="inline-block shrink-0 rounded-full bg-[#E07A5F]"
      style={{ height: size * 0.6, width: size * 0.6 }}
      animate={{ scale: [1, 1.35, 1], opacity: [0.45, 1, 0.45] }}
      transition={{ duration: 1.3, repeat: Infinity, ease: 'easeInOut' }}
    />
  )
}

interface AgentThinkingIndicatorProps {
  label?: string
  mode?: 'fetching' | 'writing' | 'settled'
  variant?: ModelVariant
  className?: string
}

export function AgentThinkingIndicator({
  label = 'চিন্তা করছি',
  mode = 'writing',
  variant = 'default',
  className,
}: AgentThinkingIndicatorProps) {
  if (mode === 'settled') return null

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <ModelSpinner variant={variant} />
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
