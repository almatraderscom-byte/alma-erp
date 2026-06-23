'use client'

import { useEffect } from 'react'
import { subscribeIosVisualViewport } from '@/lib/ios-modal-viewport'

/**
 * App-wide single source of truth for the on-screen keyboard height.
 *
 * Writes `--kb-inset` (px) on <html> and toggles `body.kb-open`, so any screen
 * can pin its footer/composer directly above the keyboard (the app owns layout —
 * `capacitor.config.ts` sets Keyboard.resize: None on purpose).
 *
 * Native (Capacitor): uses the Keyboard plugin's keyboardWillShow/Hide events.
 * Web / installed PWA: derives the inset from window.visualViewport.
 *
 * NOTE: this mirrors the agent's `src/agent/hooks/useKeyboardInset.ts`. The agent
 * keeps its own copy (one-way dependency rule: ERP must never import from
 * `src/agent/`). Both write the SAME `--kb-inset` value, so when both run on an
 * agent route the writes are idempotent — no double-counting.
 */
function setInset(px: number) {
  if (typeof document === 'undefined') return
  const value = Math.max(0, Math.round(px))
  document.documentElement.style.setProperty('--kb-inset', `${value}px`)
  document.body.classList.toggle('kb-open', value > 1)
}

export function useKeyboardInset() {
  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []

    async function setupNative(): Promise<boolean> {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (!Capacitor?.isNativePlatform?.()) return false
        // Mark the document as a native Capacitor shell. Native uses
        // Keyboard.resize: None, so window.visualViewport does NOT shrink when
        // the keyboard opens — CSS that needs to lift content above the keyboard
        // (e.g. .mobile-modal-overlay) must subtract --kb-inset, but ONLY here.
        // On web the visual viewport already shrinks, so subtracting again would
        // double-count.
        document.documentElement.classList.add('cap-native')
        cleanups.push(() => document.documentElement.classList.remove('cap-native'))
        const { Keyboard } = await import('@capacitor/keyboard')
        const show = await Keyboard.addListener('keyboardWillShow', (info) => {
          if (!disposed) setInset(info.keyboardHeight)
        })
        const hide = await Keyboard.addListener('keyboardWillHide', () => {
          if (!disposed) setInset(0)
        })
        cleanups.push(() => { void show.remove(); void hide.remove() })
        return true
      } catch {
        return false
      }
    }

    function setupWeb() {
      const unsub = subscribeIosVisualViewport(() => {
        const vv = window.visualViewport
        if (!vv) { setInset(0); return }
        setInset(window.innerHeight - vv.height - vv.offsetTop)
      })
      cleanups.push(unsub)
    }

    void setupNative().then((isNative) => {
      if (disposed) return
      if (!isNative) setupWeb()
    })

    return () => {
      disposed = true
      cleanups.forEach((c) => c())
      setInset(0)
    }
  }, [])
}
