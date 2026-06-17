'use client'

import { useKeyboardInset } from '@/agent/hooks/useKeyboardInset'

/** Headless: drives the global --kb-inset / body.kb-open from the keyboard. */
export function AgentKeyboardManager() {
  useKeyboardInset()
  return null
}
