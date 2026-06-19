'use client'

import { useEffect } from 'react'
import { useKeyboardInset, useNativeStatusBar } from '@/agent/hooks/useKeyboardInset'

/**
 * Headless: drives the global --kb-inset / body.kb-open from the keyboard, sets
 * the native status bar to dark text so the clock/battery stay readable on the
 * light agent UI, and tags <html> with `agent-route` so the document scroller is
 * locked (see agent-ambient.css) — preventing the iOS WKWebView body-pan drift
 * that auto-zoomed / clipped the UI after a few messages. Removed on unmount so
 * ERP routes keep normal page scrolling.
 */
export function AgentKeyboardManager() {
  useKeyboardInset()
  useNativeStatusBar()
  useEffect(() => {
    const root = document.documentElement
    root.classList.add('agent-route')
    return () => root.classList.remove('agent-route')
  }, [])
  return null
}
