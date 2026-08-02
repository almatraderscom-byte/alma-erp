/**
 * "Done" has to be shown, not said — owner, 2026-08-02 (audit P0-5, §G.4 + C.6).
 *
 * The audit found the head capable of narrating a success that never happened
 * (test 9: "Desktop-এ সেভ হয়েছে" — it had not). The daemon actually returns
 * good evidence for every act it performs — the text that ended up in the
 * field, whether the button reported a press, the session after a new chat —
 * but nothing on the server READ it. Success was whatever the command's exit
 * status said, and the head narrated from there.
 *
 * This module turns that evidence into a verdict, per action:
 *
 *   type      → the field must actually CONTAIN what was typed
 *   click     → the app must have reported the press
 *   new_chat  → a new session, with an empty composer
 *
 * A verdict of `unverified` is not a failure — the act may well have worked —
 * but it must never be reported to Boss as confirmed. That distinction is the
 * whole point: he can act on "I did it and checked", and he can act on "I tried
 * and could not confirm". He cannot act on a guess dressed as the first one.
 */

export type UiVerdict = 'verified' | 'unverified' | 'failed'

export interface UiOutcomeCheck {
  verdict: UiVerdict
  /** Owner-facing Bangla line — goes straight into the conversation note. */
  reasonBn: string
  /** The evidence the verdict was drawn from, for the proof span. */
  evidence: Record<string, unknown>
}

/** The daemon answers in JSON on stdout; anything else is evidence we cannot read. */
function parsePayload(stdout: string | null | undefined): Record<string, unknown> | null {
  const raw = String(stdout ?? '').trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    // Some verbs wrap the JSON in a line of text — take the last {...} block.
    const start = raw.lastIndexOf('{')
    if (start < 0) return null
    try {
      const parsed = JSON.parse(raw.slice(start))
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      return null
    }
  }
}

const norm = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Judge what the Mac reported against what was asked for. Pure — the caller
 * decides what to do with the verdict (note, proof span, tool result).
 */
export function verifyUiOutcome(input: {
  uiAction: string
  text?: string | null
  elementLabel?: string | null
  stdout?: string | null
  status?: string
}): UiOutcomeCheck {
  // Reads (tree/screenshot/scroll/session) have nothing to prove — judged
  // first, so an unreadable payload from a READ is not reported as an
  // unconfirmed act.
  if (!isVerifiableUiAction(input.uiAction)) {
    return { verdict: 'verified', reasonBn: '', evidence: {} }
  }
  if (input.status && input.status !== 'done') {
    return {
      verdict: 'failed',
      reasonBn: 'কাজটা শেষ হয়নি — Mac থেকে সফল ফল আসেনি।',
      evidence: { status: input.status },
    }
  }
  const payload = parsePayload(input.stdout)
  if (!payload) {
    return {
      verdict: 'unverified',
      reasonBn: 'Mac থেকে যাচাই করার মতো তথ্য ফেরত আসেনি — কাজটা হয়েছে বলে নিশ্চিত করে বলছি না।',
      evidence: {},
    }
  }

  switch (input.uiAction) {
    case 'ui_type': {
      const fieldValue = payload.fieldValue
      const wanted = norm(input.text)
      const got = norm(fieldValue)
      // The daemon reports `typed` as the CHARACTER COUNT, not a boolean — read
      // off a real run (fieldValue "ALMA P0-3 proof", typed 15). Checking for
      // `=== true` turned every successful type into a reported failure, which
      // is the same class of lie this module exists to prevent, pointed the
      // other way.
      const didType = payload.typed === true
        || (typeof payload.typed === 'number' && payload.typed > 0)
      if (didType && wanted && got.includes(wanted)) {
        return {
          verdict: 'verified',
          reasonBn: 'লেখাটা ঘরে বসেছে — নিজে পড়ে মিলিয়ে দেখেছি।',
          evidence: { fieldValue, typed: true },
        }
      }
      if (didType) {
        return {
          verdict: 'unverified',
          reasonBn: `লেখা পাঠানো হয়েছে, কিন্তু ঘরে যা আছে সেটা হুবহু মেলেনি (${String(fieldValue ?? '').slice(0, 60)}) — নিশ্চিত করে বলছি না।`,
          evidence: { fieldValue, typed: true },
        }
      }
      return {
        verdict: 'failed',
        reasonBn: 'লেখাটা ঘরে বসেনি।',
        evidence: { fieldValue: fieldValue ?? null, typed: payload.typed ?? 0 },
      }
    }
    case 'ui_click': {
      if (payload.clicked) {
        return {
          verdict: 'verified',
          reasonBn: `"${input.elementLabel ?? ''}" চাপা হয়েছে — অ্যাপ নিজে সেটা স্বীকার করেছে।`,
          evidence: { clicked: payload.clicked, diff: payload.diff ?? null },
        }
      }
      return { verdict: 'failed', reasonBn: 'বোতামটা চাপা যায়নি।', evidence: { clicked: payload.clicked ?? false } }
    }
    case 'ui_new_chat': {
      const session = (payload.session ?? null) as Record<string, unknown> | null
      if (payload.clicked && session?.composerEmpty === true) {
        return {
          verdict: 'verified',
          reasonBn: 'নতুন খালি চ্যাট খুলেছে — খুলে নিজে দেখে নিশ্চিত হয়েছি।',
          evidence: { clicked: payload.clicked, session },
        }
      }
      return {
        verdict: 'failed',
        reasonBn: 'নতুন চ্যাট খুলেছে বলে প্রমাণ পাইনি — তাই ওখানে কিছু লিখিনি।',
        evidence: { clicked: payload.clicked ?? false, session },
      }
    }
    default:
      return { verdict: 'verified', reasonBn: '', evidence: {} }
  }
}

/** Actions whose outcome is worth a verdict at all. */
export function isVerifiableUiAction(uiAction: string): boolean {
  return uiAction === 'ui_type' || uiAction === 'ui_click' || uiAction === 'ui_new_chat'
}
