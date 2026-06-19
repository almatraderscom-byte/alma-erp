/**
 * Light haptic feedback for the agent chat — a subtle single pulse when the
 * agent finishes a reply, like the Claude app on a phone. Uses the Web
 * Vibration API (same approach as src/lib/mobile-refresh.ts) so no native
 * plugin / APK rebuild is needed. Silently no-ops where unsupported
 * (desktop browsers, iOS WebView).
 */
export function agentReplyHaptic(): void {
  if (typeof navigator === 'undefined' || typeof navigator.vibrate !== 'function') return
  try {
    navigator.vibrate(14) // soft, brief tap — barely-there, not a buzz
  } catch {
    /* vibration blocked/unsupported — ignore */
  }
}
