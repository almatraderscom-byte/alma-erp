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
