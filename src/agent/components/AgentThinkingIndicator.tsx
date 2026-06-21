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
 * The three Claude-app-style working states the owner asked for, plus a terminal
 * 'settled' that hides the indicator. Drives both the AlmaSpinner animation and
 * its rotating verb (Thinking → Searching → Writing).
 */
export type ThinkingMode = 'thinking' | 'searching' | 'writing' | 'settled'

/** Human-facing model/brand name shown beside the spinner. */
const VARIANT_NAME: Record<ModelVariant, string> = {
  claude: 'Claude',
  qwen: 'Qwen',
  deepseek: 'DeepSeek',
  default: 'ALMA',
}

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
  mode?: ThinkingMode
  variant?: ModelVariant
  className?: string
}

export function AgentThinkingIndicator({
  mode = 'thinking',
  variant = 'default',
  className,
}: AgentThinkingIndicatorProps) {
  if (mode === 'settled') return null

  // The three states map 1:1 onto the AlmaSpinner's own modes + rotating verbs
  // (thinking → "Pondering…", searching → "Searching…", writing → "Writing…"),
  // exactly the Claude-app feel the owner asked for.
  const spinnerMode: AlmaSpinnerMode = mode
  const name = VARIANT_NAME[variant] ?? 'ALMA'

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {/* The owner's animation with its Claude-style rotating verb (showVerb),
          haptic + sound synced. This is the single primary "agent is working"
          indicator, so it owns the feedback. */}
      <AlmaSpinner mode={spinnerMode} size={18} showVerb haptics sound />
      {/* Brand + model name so the owner always sees WHO is working. */}
      <span className="alma-thinking-shimmer text-[12px] font-medium text-muted">
        {variant === 'default' ? 'ALMA' : `ALMA · ${name}`}
      </span>
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
