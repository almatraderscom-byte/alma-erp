/**
 * Long-press → native action sheet bridge (native iOS shell only).
 *
 * Any element carrying `data-ctx-menu` (a JSON array of `{key,label,role?}`) shows a
 * NATIVE UIKit action sheet when long-pressed inside the app. Native sends the picked
 * key back via `window.__almaCtxPick(key)`, which we turn into an `alma-ctx-pick`
 * CustomEvent on the element — so the element's own React handler runs the action.
 *
 * Fully gated: if the native `almaContextMenu` handler is absent (any browser, or an
 * older build) this installs nothing and long-press behaves normally.
 */

type CtxItem = { key: string; label: string; role?: 'destructive' }

function nativeContextHandler():
  | { postMessage: (m: unknown) => void }
  | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as {
    webkit?: { messageHandlers?: { almaContextMenu?: { postMessage: (m: unknown) => void } } }
  }
  return w.webkit?.messageHandlers?.almaContextMenu ?? null
}

/** True only inside the native shell, where the context-menu handler exists. */
export function hasNativeContextMenu(): boolean {
  return nativeContextHandler() != null
}

/** Install the global long-press listener. Returns a cleanup function. */
export function installNativeContextMenu(): () => void {
  if (typeof document === 'undefined' || !nativeContextHandler()) return () => {}

  let timer: number | null = null
  let startX = 0
  let startY = 0

  const clear = () => {
    if (timer !== null) {
      window.clearTimeout(timer)
      timer = null
    }
  }

  const onDown = (e: PointerEvent) => {
    const el = (e.target as HTMLElement | null)?.closest?.('[data-ctx-menu]') as HTMLElement | null
    if (!el) return
    const handler = nativeContextHandler()
    if (!handler) return
    startX = e.clientX
    startY = e.clientY
    clear()
    timer = window.setTimeout(() => {
      timer = null
      let items: CtxItem[] = []
      try {
        items = JSON.parse(el.getAttribute('data-ctx-menu') || '[]')
      } catch {
        items = []
      }
      if (!items.length) return
      // One-shot pick dispatcher: native calls this with the chosen key.
      ;(window as unknown as { __almaCtxPick?: (key: string) => void }).__almaCtxPick = (key: string) => {
        el.dispatchEvent(new CustomEvent('alma-ctx-pick', { detail: { key }, bubbles: true }))
      }
      try {
        handler.postMessage({
          title: el.getAttribute('data-ctx-title') || undefined,
          subtitle: el.getAttribute('data-ctx-subtitle') || undefined,
          items,
        })
      } catch {
        /* not in the native shell — ignore */
      }
      // 420ms fires just before WKWebView's own ~500ms long-press (text-select /
      // callout) so ours wins; the `-webkit-touch-callout:none` CSS on the cards
      // stops that native gesture from cancelling our pointer sequence anyway.
    }, 420)
  }

  const onMove = (e: PointerEvent) => {
    if (timer !== null && (Math.abs(e.clientX - startX) > 10 || Math.abs(e.clientY - startY) > 10)) {
      clear()
    }
  }

  const opts = { capture: true, passive: true } as const
  document.addEventListener('pointerdown', onDown, opts)
  document.addEventListener('pointermove', onMove, opts)
  document.addEventListener('pointerup', clear, opts)
  document.addEventListener('pointercancel', clear, opts)

  return () => {
    clear()
    document.removeEventListener('pointerdown', onDown, opts)
    document.removeEventListener('pointermove', onMove, opts)
    document.removeEventListener('pointerup', clear, opts)
    document.removeEventListener('pointercancel', clear, opts)
  }
}
