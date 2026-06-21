'use client'

import { cn } from '@/lib/utils'
import { AlmaSpinner, type AlmaSpinnerMode } from './AlmaSpinner'

/**
 * Per-model / per-role identity is still carried by `variant` (so callers and
 * the model NAME labels stay unchanged), but every model now shares ONE loading
 * animation: the owner-supplied AlmaSpinner. The name keeps showing exactly as
 * before — only the spinner art is unified.
 */
export type ModelVariant = 'claude' | 'qwen' | 'deepseek' | 'default'

/**
 * Spinner shown next to each sub-agent / role. The role NAME is rendered by the
 * caller (e.g. `d.roleLabel` in AgentThread), so this is the glyph only:
 * no verb text, and no haptics/sound (several can render at once — buzzing/
 * ticking per sub-agent would be chaos; the main indicator owns that).
 */
export function ModelSpinner({
  variant = 'default',
  size = 14,
}: {
  /** Kept for API compatibility / call sites; the animation is now unified. */
  variant?: ModelVariant
  size?: number
}) {
  void variant
  return <AlmaSpinner mode="thinking" size={size} showVerb={false} haptics={false} sound={false} />
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
  void variant

  // Map the agent's mode onto the AlmaSpinner rhythm.
  const spinnerMode: AlmaSpinnerMode = mode === 'fetching' ? 'searching' : 'writing'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* The one shared animation, with haptic + sound synced. This is the
          single primary "agent is working" indicator, so it owns the feedback;
          the Bangla status label below keeps naming what's happening, as before. */}
      <AlmaSpinner mode={spinnerMode} size={20} showVerb={false} haptics sound />
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
