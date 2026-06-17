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
