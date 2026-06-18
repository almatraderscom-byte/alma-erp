'use client'

import { useKeyboardInset, useNativeStatusBar } from '@/agent/hooks/useKeyboardInset'

/**
 * Headless: drives the global --kb-inset / body.kb-open from the keyboard, and
 * sets the native status bar to dark text so the clock/battery stay readable on
 * the light agent UI.
 */
export function AgentKeyboardManager() {
  useKeyboardInset()
  useNativeStatusBar()
  return null
}
