/**
 * Native shell (iOS) detection for "embed mode".
 *
 * The native iOS app loads the live site inside WKWebViews arranged in a NATIVE
 * tab bar and navigation. When it does, it injects `window.__almaNative = true` at
 * document-start. In that mode the web should hide its own chrome (bottom nav, the
 * agent sub-nav) so it doesn't stack under the native tab bar, and report route
 * changes to native (see NativeShellBridge).
 *
 * Everything gated on this is ADDITIVE: in a normal browser (desktop or mobile web)
 * `isNativeShell()` is false and nothing changes. `?native=1` forces it on for
 * browser testing.
 */
export function isNativeShell(): boolean {
  if (typeof window === 'undefined') return false
  try {
    if ((window as unknown as { __almaNative?: boolean }).__almaNative) return true
    return new URLSearchParams(window.location.search).has('native')
  } catch {
    return false
  }
}
