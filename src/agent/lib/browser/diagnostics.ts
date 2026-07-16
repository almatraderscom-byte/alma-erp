/**
 * Phase 48 — browser/network failure diagnosis: owner-fixable vs
 * vendor/platform, retryable vs not. The operator never claims control it
 * does not have — a Meta outage is diagnosed and reported, not "fixed".
 * Pure and deterministic.
 */

export type BrowserFailureKind =
  | 'offline_dns'
  | 'tls'
  | 'http_5xx'
  | 'http_4xx'
  | 'auth_expired'
  | 'permission_denied'
  | 'api_deprecated'
  | 'upload_failed'
  | 'selector_broken'
  | 'third_party_outage'
  | 'timeout'
  | 'prompt_injection'
  | 'unknown'

export interface FailureDiagnosis {
  kind: BrowserFailureKind
  /** True when the OWNER can fix it (re-login, permission, config). */
  ownerFixable: boolean
  /** True when a plain retry (possibly later) is sensible. */
  retryable: boolean
  /** What actually happens next, honestly (Bangla, owner-readable). */
  playbookBn: string
}

const D = (kind: BrowserFailureKind, ownerFixable: boolean, retryable: boolean, playbookBn: string): FailureDiagnosis => ({
  kind, ownerFixable, retryable, playbookBn,
})

/** Classify a raw error string from the runner/extension/network layer. */
export function diagnoseBrowserFailure(error: string): FailureDiagnosis {
  const e = error.toLowerCase()

  if (/err_name_not_resolved|enotfound|dns|err_internet_disconnected|net::err_connection_refused|econnrefused/.test(e)) {
    return D('offline_dns', false, true, 'নেট/DNS সমস্যা — সাইটে পৌঁছানোই যাচ্ছে না। একটু পরে আবার চেষ্টা হবে; VPS-এর নেট ঠিক থাকলে সমস্যাটা সাইটের দিকের।')
  }
  if (/err_cert|certificate|ssl|tls/.test(e)) {
    return D('tls', false, false, 'সাইটের TLS/certificate সমস্যা — এটা ওই সাইটের মালিকের ঠিক করার জিনিস; আমরা bypass করবো না।')
  }
  if (/prompt.?injection|injection tripwire/.test(e)) {
    return D('prompt_injection', false, false, 'পেজটা এজেন্টকে নির্দেশ দেওয়ার চেষ্টা করেছে — ডোমেইন lockdown হয়েছে; owner review ছাড়া ওখানে আর অ্যাকশন হবে না।')
  }
  if (/http 5\d\d|status.?5\d\d| 5\d\d[^0-9]|internal server error|bad gateway|service unavailable/.test(e)) {
    return D('http_5xx', false, true, 'সার্ভার-সাইড error (5xx) — vendor-এর সমস্যা; কিছুক্ষণ পরে retry হবে। আমরা ওদের সার্ভার ঠিক করতে পারি না, শুধু ধরা পড়লে জানাতে পারি।')
  }
  if (/session (expired|invalid)|logged out|sign.?in again|401|unauthorized|token.*(expired|invalid)/.test(e)) {
    return D('auth_expired', true, false, 'লগইন/টোকেন মেয়াদ শেষ — Boss আবার লগইন করলে (বা টোকেন নবায়ন করলে) কাজ আবার চলবে। পাসওয়ার্ড/OTP এজেন্ট কখনো নিজে দেয় না।')
  }
  if (/403|forbidden|permission denied|not authorized|access denied/.test(e)) {
    return D('permission_denied', true, false, 'Permission নেই — অ্যাকাউন্ট/অ্যাসেটে access দেওয়া owner-এর কাজ; দিলে আবার চেষ্টা হবে।')
  }
  if (/deprecated|no longer supported|unsupported api version|version.*(sunset|retired)/.test(e)) {
    return D('api_deprecated', false, false, 'API version অবসরে গেছে — code-এ central version bump লাগবে (changelog যাচাই করে), অন্ধ retry অর্থহীন।')
  }
  if (/upload (failed|error)|file too large|processing failed|media.*(failed|error)/.test(e)) {
    return D('upload_failed', false, true, 'আপলোড/প্রসেসিং fail — ফাইল re-sign/re-upload করে retry হবে; বারবার হলে ফাইলটাই সমস্যা।')
  }
  if (/(selector|locator|element).*(not found|timeout|detached)|no element matches|waiting for selector/.test(e)) {
    return D('selector_broken', false, false, 'পেজের গঠন বদলেছে — পুরোনো selector আর নেই। Recipe আপডেট করতে হবে; একই selector-এ retry বৃথা।')
  }
  if (/(facebook|meta|google|instagram).*(outage|down|unavailable)|platform.*(outage|down)/.test(e)) {
    return D('third_party_outage', false, true, 'Vendor/platform outage — এটা আমাদের নিয়ন্ত্রণের বাইরে; স্ট্যাটাস দেখে পরে retry হবে। "ইন্টারনেট ঠিক করে দেব" জাতীয় দাবি এজেন্ট করে না।')
  }
  if (/timeout|timed out|deadline/.test(e)) {
    return D('timeout', false, true, 'সময়সীমা পার — লম্বা কাজ VPS queue-তে checkpoint-সহ চলবে; শেষ verified step থেকে resume হবে।')
  }
  if (/http 4\d\d|status.?4\d\d| 4\d\d[^0-9]|not found|bad request/.test(e)) {
    return D('http_4xx', false, false, 'Request-টাই ভুল বা জিনিসটা নেই (4xx) — এজেন্ট request ঠিক করে তবেই আবার চেষ্টা করবে।')
  }
  return D('unknown', false, false, 'অজানা সমস্যা — এজেন্ট আগে কারণ বের করবে (diagnostics), অন্ধ retry হবে না।')
}
