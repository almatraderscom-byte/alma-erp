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
 * Launch the bKash app. Inside the Capacitor shell (iOS/Android) a non-http(s)
 * navigation is forwarded to the OS which opens the app — same path the existing
 * tel: links use, so no native build is needed. Mobile browsers behave the same;
 * desktop quietly no-ops (the copied number still works for bKash web/manual).
 */
export function openBkashApp(): void {
  if (typeof window === 'undefined') return
  window.location.href = 'bkash://'
}

/** Clipboard write with a safe failure mode (false = tell the owner to copy manually). */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator === 'undefined') return false
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
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
