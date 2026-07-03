export type VoiceState = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking' | 'error'

export type VoiceMode = 'off' | 'dictation' | 'conversation'

/**
 * Live turn events the voice console renders as action cards / captions while
 * the head works. A filtered projection of the chat SSE stream — the console
 * only needs what's visible, not the full thread bookkeeping.
 */
export type VoiceTurnEvent =
  | { type: 'tool_start'; id: string; name: string }
  | { type: 'tool_end'; id: string; success: boolean; resultPreview?: string }
  | { type: 'subagent_start'; id: string; roleLabel: string }
  | { type: 'subagent_end'; id: string; success?: boolean }
  | { type: 'text_delta'; delta: string }
  | { type: 'confirm_card'; pendingActionId?: string; summary?: string; costEstimate?: number; actionType?: string }
  | { type: 'ask_card'; askCardId: string; question: string; options: string[] }
  | { type: 'error'; message?: string }
  | { type: 'verification_retry' }
  | { type: 'model_switch_required' }
  | { type: 'thinking' }
