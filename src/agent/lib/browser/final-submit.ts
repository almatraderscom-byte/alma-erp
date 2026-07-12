/**
 * Final-submit click ban (Growth Feature 8) — enforced IN CODE, not just prompt.
 *
 * The live-browser rule has always been: the agent may fill forms and navigate,
 * but the last irreversible button (Send / Post / Pay / Publish / Confirm /
 * Delete…) is the OWNER's to press. Until now that lived only in the tool
 * description; this module is the code gate. It runs in two layers:
 *   1. live_browser_act (server): blocks a click whose target text/selector
 *      matches before the command is even sent to the extension.
 *   2. extension pageClick (client): re-checks the RESOLVED element's real
 *      label in-page — covers ref/selector targeting where the server can't
 *      see the button text. (extension/alma-companion/background.js mirrors
 *      this regex; keep the two in sync when editing.)
 *
 * Word-boundaries: \b works for the English verbs; Bangla has no \b semantics
 * in JS regex, so the Bangla alternatives are full imperative phrases that
 * don't appear inside innocent labels.
 */
export const FINAL_SUBMIT_RE = new RegExp(
  [
    '\\b(send|post|publish|pay|buy|purchase|confirm|delete|transfer|submit|checkout)\\b',
    '\\bplace\\s+order\\b',
    '\\border\\s+now\\b',
    'পাঠান',
    'পাঠিয়ে\\s*দিন',
    'পোস্ট\\s*করুন',
    'পাবলিশ',
    'প্রকাশ\\s*করুন',
    'কিনুন',
    'অর্ডার\\s*করুন',
    'নিশ্চিত\\s*করুন',
    'কনফার্ম',
    'ডিলিট',
    'মুছে\\s*ফেলুন',
    'সাবমিট',
    'পেমেন্ট\\s*করুন',
  ].join('|'),
  'i',
)

/**
 * Composition-mode buttons that CONTAIN a final verb but only OPEN an editor —
 * nothing goes live until a separate Publish click (which stays blocked).
 * 2026-07-12 carousel incident: Ads Manager's "Create post" (switches the ad
 * creative from "Use existing posts" to composing a new one, still a draft)
 * was blocked as a final Post button and the whole task dead-ended.
 * Keep deliberately narrow: create/new + post/ad only.
 * (extension/alma-companion/background.js mirrors this — keep in sync.)
 */
export const COMPOSE_EXEMPT_RE =
  /\b(create|new)\s+(a\s+)?(post|ad)\b|নতুন\s*(পোস্ট|বিজ্ঞাপন)|পোস্ট\s*তৈরি/i

/** True when a click-target label/text looks like a final irreversible submit. */
export function isFinalSubmitText(...texts: Array<string | null | undefined>): boolean {
  const hay = texts.filter(Boolean).join(' ').trim()
  if (!hay) return false
  if (COMPOSE_EXEMPT_RE.test(hay)) return false
  return FINAL_SUBMIT_RE.test(hay)
}

export const FINAL_SUBMIT_BLOCK_MESSAGE =
  '🛑 এই ক্লিকটা কোড-লেভেলে ব্লক করা: এটা একটা final Send/Post/Pay/Confirm/Delete বাটন — ' +
  'এই শেষ অপরিবর্তনীয় ক্লিকটা owner নিজ হাতে চাপবেন। ফর্ম পূরণ/নেভিগেশন পর্যন্ত সব শেষ করে ' +
  'owner-কে বলুন বাটনটা নিজে চাপতে।'
