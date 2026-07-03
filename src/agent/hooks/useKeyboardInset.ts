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

/**
 * True only inside the iOS native-frame shell (SpikeNativeShell): the app hosts the
 * agent in a plain WKWebView whose bottom is pinned to the keyboard via
 * `keyboardLayoutGuide`, so NATIVE already shrinks the viewport above the keyboard —
 * exactly like Capacitor's resize:Native, but without the Capacitor bridge. Detected
 * by the `almaShell` message handler the shell injects; absent in normal browsers and
 * even under `?native=1` (only the real app registers it).
 */
function inNativeShellWebView(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return !!(window as unknown as {
      webkit?: { messageHandlers?: { almaShell?: unknown } }
    }).webkit?.messageHandlers?.almaShell
  } catch {
    return false
  }
}

export function useKeyboardInset() {
  useEffect(() => {
    let disposed = false
    const cleanups: Array<() => void> = []

    async function setupNative(): Promise<boolean> {
      try {
        const { Capacitor } = await import('@capacitor/core')
        if (!Capacitor?.isNativePlatform?.()) return false
        const { Keyboard, KeyboardResize } = await import('@capacitor/keyboard')

        // Let iOS/Android resize the native WebView so the composer sits directly
        // above the keyboard — the same mechanism native apps use. Scoped to the
        // agent screen ONLY: the global default stays resize:None so the ERP keeps
        // its manual --kb-inset path and can't double-count. We restore None on
        // unmount (leaving /agent/*).
        //
        // Why this and not CSS: with resize:None the WebView never shrinks, so the
        // measured-inset CSS lift was unreliable inside WKWebView (worked in Safari,
        // not in the installed app). Native resize removes that whole guess.
        try { await Keyboard.setResizeMode({ mode: KeyboardResize.Native }) } catch { /* older shell */ }
        document.documentElement.classList.add('cap-native-resize')

        const openNav = () => { if (!disposed) document.body.classList.add('kb-open') }
        const closeNav = () => { if (!disposed) document.body.classList.remove('kb-open') }
        // iOS owns the lift now, so keep --kb-inset at 0 (subtracting it too would
        // float the composer a full keyboard-height too high). We only toggle
        // kb-open to hide the floating bottom nav while typing.
        const show = await Keyboard.addListener('keyboardWillShow', openNav)
        const hide = await Keyboard.addListener('keyboardWillHide', closeNav)

        cleanups.push(() => {
          void show.remove(); void hide.remove()
          void Keyboard.setResizeMode({ mode: KeyboardResize.None }).catch(() => {})
          document.documentElement.classList.remove('cap-native-resize')
        })
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

    // iOS native-frame shell (plain WKWebView, NOT Capacitor): the shell already
    // shrinks the WebView above the keyboard via keyboardLayoutGuide. Running the
    // visualViewport path here made the two fight — the measured inset settled near
    // 0 (the view had already shrunk) so `kb-open` never latched, leaving the agent
    // bottom-nav wedged between the composer and the keyboard and flickering during
    // the animation. So mirror the Capacitor branch instead: pin --kb-inset at 0,
    // set cap-native-resize (so .agent-main-height fills the shrunk viewport), and
    // drive kb-open purely from focus (the keyboard is up iff an editable is focused).
    function setupNativeShell() {
      document.documentElement.classList.add('cap-native-resize')
      setInset(0)
      const openNav = (e: FocusEvent) => {
        if (!disposed && isEditableTarget(e.target)) document.body.classList.add('kb-open')
      }
      const closeNav = () => { if (!disposed) document.body.classList.remove('kb-open') }
      document.addEventListener('focusin', openNav)
      document.addEventListener('focusout', closeNav)
      cleanups.push(() => {
        document.removeEventListener('focusin', openNav)
        document.removeEventListener('focusout', closeNav)
        document.documentElement.classList.remove('cap-native-resize')
      })
    }

    // Optimistic lift: the moment an input/textarea is focused, raise the
    // composer to the last measured keyboard height instead of waiting for the
    // native keyboardWillShow event (which can lag 2-5s on some Android shells).
    // Safe on desktop: lastKnownKbHeight stays 0 there, so this is a no-op.
    // Skipped in the native-frame shell, where native owns the lift and any inset
    // would double-lift the composer.
    function onFocusIn(e: FocusEvent) {
      if (disposed || !isEditableTarget(e.target)) return
      if (document.body.classList.contains('kb-open')) return
      const h = lastKnownKbHeight()
      if (h > 0) setInset(h)
    }

    // The native-frame shell webview takes precedence over both the Capacitor and
    // the web/visualViewport paths (it is neither): native handles the resize.
    if (inNativeShellWebView()) {
      setupNativeShell()
    } else {
      document.addEventListener('focusin', onFocusIn)
      cleanups.push(() => document.removeEventListener('focusin', onFocusIn))
      void setupNative().then((isNative) => {
        if (disposed) return
        if (!isNative) setupWeb()
      })
    }

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
