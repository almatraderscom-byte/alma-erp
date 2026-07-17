/**
 * bKash send-money confirmation flow (semi-auto "TrxID paste", owner-only).
 *
 * The owner approves a withdrawal → we copy the staff member's bKash number,
 * remember the in-flight request in localStorage, and deep-link into the bKash
 * app. When the owner returns (visibilitychange / page load), the payroll page
 * re-opens the confirm sheet from this stored state so the TrxID can be pasted
 * and the normal APPROVE PATCH completes the record.
 *
 * localStorage (not sessionStorage/state) on purpose: iOS may kill the WebView
 * while the owner is inside bKash — the half-done confirmation must survive a
 * full app relaunch.
 */

export type BkashSendPending = {
  /** Which screen owns this half-done send — its id spaces differ (walletRequest
   *  id on /payroll vs approvalRequest id on /approvals), so each surface only
   *  restores its own. */
  surface: 'payroll' | 'approvals'
  requestId: string
  employeeId: string
  businessId: string
  requestedAmount: number
  approvedAmount: number
  recipientNumber: string
  recipientName: string | null
  startedAt: number
}

const STORAGE_KEY = 'alma.bkashSendPending.v1'
/** After 12h a half-done send is stale — nagging the owner with it does more harm than good. */
const PENDING_TTL_MS = 12 * 60 * 60 * 1000

export function saveBkashSendPending(pending: BkashSendPending): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pending))
  } catch {
    /* storage full/blocked — flow degrades to the manual TrxID field */
  }
}

export function readBkashSendPending(): BkashSendPending | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<BkashSendPending>
    if (!parsed?.requestId || !parsed.startedAt) {
      clearBkashSendPending()
      return null
    }
    if (Date.now() - parsed.startedAt > PENDING_TTL_MS) {
      clearBkashSendPending()
      return null
    }
    return parsed as BkashSendPending
  } catch {
    return null
  }
}

export function clearBkashSendPending(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}

/**
 * Pull a bKash TrxID out of arbitrary clipboard text. TrxIDs are 10 uppercase
 * alphanumerics with at least one digit (e.g. BFJ90KAL2M) — the digit guard
 * keeps 10-letter words from matching; word boundaries keep 11-digit phone
 * numbers and amounts out.
 */
export function extractTrxIdFromText(text: string | null | undefined): string | null {
  if (!text) return null
  const m = text.toUpperCase().match(/(?<![A-Z0-9])(?=[A-Z0-9]{0,9}\d)[A-Z0-9]{10}(?![A-Z0-9])/)
  return m ? m[0] : null
}

/**
 * The bKash app's Universal Link — the only opener bKash actually publishes.
 *
 * Evidence (https://bka.sh/.well-known/apple-app-site-association):
 *   {"applinks":{"details":[{"appID":"4XPYVR2AGK.com.bKash.customerapp","paths":["/next"]}]}}
 * App installed → iOS hands the tap straight to bKash and this page never loads.
 * Not installed → the page loads and forwards to the App Store listing.
 *
 * This replaced a `bkash://` custom scheme that was a guess: bKash documents no such
 * scheme, and the owner got Safari's "cannot open the page because the address is
 * invalid" from it on 2026-07-17. Don't reintroduce a custom scheme without proof
 * from a device that has bKash installed — the simulator cannot answer this question
 * (no App Store there, so bKash can never be installed to claim a scheme).
 */
export const BKASH_APP_URL = 'https://bka.sh/next'

/**
 * Navigate to the bKash app. MUST be called synchronously inside the tap handler:
 * iOS only honours a Universal Link while the user-gesture flag is live, and any
 * `await`/`setTimeout` before it drops that flag (the original bug).
 */
export function openBkashApp(): void {
  if (typeof window === 'undefined') return
  window.location.href = BKASH_APP_URL
}

/**
 * Copy inside the tap, synchronously. The async Clipboard API only resolves on a
 * later microtask — by then the gesture flag the Universal Link needs is gone, so
 * we cannot await it before navigating. execCommand is deprecated but is the only
 * synchronous path and still works in every browser this app ships to; the async
 * API runs as a best-effort backup when it fails.
 */
export function copyTextToClipboard(text: string): boolean {
  if (typeof document === 'undefined') return false
  let copied = false
  try {
    const el = document.createElement('textarea')
    el.value = text
    el.contentEditable = 'true'
    el.readOnly = false
    el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;'
    document.body.appendChild(el)
    // iOS Safari ignores .select() on a synthetic textarea — it needs a real range.
    const range = document.createRange()
    range.selectNodeContents(el)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    el.setSelectionRange(0, text.length)
    copied = document.execCommand('copy')
    selection?.removeAllRanges()
    el.remove()
  } catch {
    copied = false
  }
  if (!copied) {
    try {
      void navigator.clipboard?.writeText(text).catch(() => {})
    } catch {
      /* nothing else to try — the sheet shows the number for manual entry */
    }
  }
  return copied
}

/**
 * Clipboard read — must run from a user gesture (button tap). On iOS WKWebView
 * this shows the system paste banner; on web Chrome a permission prompt.
 * Returns null when unavailable/denied so the caller falls back to manual paste.
 */
export async function readClipboardText(): Promise<string | null> {
  if (typeof navigator === 'undefined') return null
  try {
    const nav = navigator as Navigator & { clipboard?: { readText?: () => Promise<string> } }
    if (!nav.clipboard?.readText) return null
    return await nav.clipboard.readText()
  } catch {
    return null
  }
}
