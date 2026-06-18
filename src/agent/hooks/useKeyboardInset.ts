'use client'

import { useEffect } from 'react'
import { subscribeIosVisualViewport } from '@/lib/ios-modal-viewport'

/**
 * Single source of truth for the on-screen keyboard height.
 *
 * Writes `--kb-inset` (px) on <html> and toggles `body.kb-open`, so the agent
 * layout can pin the composer directly above the keyboard and hide the bottom
 * nav — ChatGPT-style — instead of letting them float mid-screen.
 *
 * Native (Capacitor): uses the Keyboard plugin's keyboardWillShow/Hide events.
 * Web / installed PWA: derives the inset from window.visualViewport.
 */
function setInset(px: number) {
  if (typeof document === 'undefined') return
  const value = Math.max(0, Math.round(px))
  document.documentElement.style.setProperty('--kb-inset', `${value}px`)
  document.body.classList.toggle('kb-open', value > 1)
}

// Last measured keyboard height, cached per-device so we can lift the composer
// optimistically the moment the input is focused — instead of waiting for the
// native keyboardWillShow event, which can lag 2-5s on some Android devices.
const KB_HEIGHT_KEY = 'alma-kb-height'
function lastKnownKbHeight(): number {
  if (typeof window === 'undefined') return 0
  try {
    const v = Number(window.localStorage.getItem(KB_HEIGHT_KEY) ?? '0')
    return Number.isFinite(v) && v > 1 ? v : 0
  } catch {
    return 0
  }
}
function rememberKbHeight(px: number) {
  if (typeof window === 'undefined' || px <= 1) return
  try {
    window.localStorage.setItem(KB_HEIGHT_KEY, String(Math.round(px)))
  } catch {
    /* storage blocked — ignore */
  }
}
function isEditableTarget(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName.toLowerCase()
  return tag === 'textarea' || tag === 'input' || node.isContentEditable === true
}

export function useKeyboardInset() {
  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []

    async function setupNative(): Promise<boolean> {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (!Capacitor?.isNativePlatform?.()) return false
        const { Keyboard } = await import('@capacitor/keyboard')
        const show = await Keyboard.addListener('keyboardWillShow', (info) => {
          if (disposed) return
          rememberKbHeight(info.keyboardHeight)
          setInset(info.keyboardHeight)
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
        const inset = window.innerHeight - vv.height - vv.offsetTop
        rememberKbHeight(inset)
        setInset(inset)
      })
      cleanups.push(unsub)
    }

    // Optimistic lift: the moment an input/textarea is focused, raise the
    // composer to the last measured keyboard height instead of waiting for the
    // native keyboardWillShow event (which can lag 2-5s on some Android shells).
    // Safe on desktop: lastKnownKbHeight stays 0 there, so this is a no-op.
    function onFocusIn(e: FocusEvent) {
      if (disposed || !isEditableTarget(e.target)) return
      if (document.body.classList.contains('kb-open')) return
      const h = lastKnownKbHeight()
      if (h > 0) setInset(h)
    }
    document.addEventListener('focusin', onFocusIn)
    cleanups.push(() => document.removeEventListener('focusin', onFocusIn))

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

/**
 * On the native iOS/Android shell the status bar OVERLAYS the WebView. The agent
 * UI is light (#FAF9F6), so the bar needs DARK text/icons or the clock + battery
 * are invisible (the native default was light/white text → unreadable on light).
 *
 * Style.Light = dark content for light backgrounds. Web/PWA is a no-op.
 */
export function useNativeStatusBar() {
  useEffect(() => {
    let disposed = false
    ;(async () => {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (disposed || !Capacitor?.isNativePlatform?.()) return
        const { StatusBar, Style } = await import('@capacitor/status-bar')
        await StatusBar.setStyle({ style: Style.Light })
        // Keep the bar overlaying the WebView so safe-area-inset-top stays > 0
        // (the agent layout reserves that strip via `safe-top`).
        try { await StatusBar.setOverlaysWebView({ overlay: true }) } catch {}
      } catch {
        /* plugin unavailable (web) — ignore */
      }
    })()
    return () => { disposed = true }
  }, [])
}
