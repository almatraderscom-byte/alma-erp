'use client'

import { motion } from 'framer-motion'
import { cn } from '@/lib/utils'

/**
 * Small coral→teal pulsing dot trio — the on-theme "agent is working" indicator.
 * Replaces the pale sparkle box that clashed with the dark agent theme. Used in
 * the delegation card while a worker runs and its answer streams in below.
 */
export default function AgentWorkingDots({ className }: { className?: string }) {
  return (
    <span
      className={cn('inline-flex items-center gap-1', className)}
      role="status"
      aria-live="polite"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="h-1.5 w-1.5 rounded-full bg-gradient-to-br from-[#E07A5F] to-[#81B29A]"
          animate={{ opacity: [0.3, 1, 0.3], scale: [0.75, 1.15, 0.75] }}
          transition={{ duration: 1.15, repeat: Infinity, ease: 'easeInOut', delay: i * 0.18 }}
        />
      ))}
    </span>
  )
}
