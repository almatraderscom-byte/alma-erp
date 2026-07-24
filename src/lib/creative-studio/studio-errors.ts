const GENERIC_BN = 'কাজটি এখন সম্পন্ন করা যায়নি। একটু পরে আবার চেষ্টা করুন।'

const CODE_MESSAGES: Record<string, string> = {
  unauthorized: 'আপনার সেশন শেষ হয়েছে। আবার লগইন করুন।',
  forbidden: 'এই কাজের অনুমতি আপনার নেই।',
  agent_disabled: 'Creative Studio এখন বন্ধ আছে।',
  invalid_json: 'পাঠানো তথ্যটি ঠিক নয়। আবার চেষ্টা করুন।',
  gallery_failed: 'Gallery লোড করা যায়নি। আবার চেষ্টা করুন।',
  cost_confirmation_required: 'খরচ নিশ্চিত করে তারপর কাজটি চালান।',
  cost_cap_exceeded: 'আপনার নির্ধারিত সর্বোচ্চ খরচের চেয়ে এই কাজের খরচ বেশি।',
  cost_estimate_changed: 'খরচ বদলেছে। নতুন হিসাব দেখে আবার নিশ্চিত করুন।',
  qc_failed_blocked: 'এই Creative-টির QC ফেল করেছে। আগে Repair বা Retry করে QC পাস করান।',
  too_many_requests: 'একসাথে অনেক অনুরোধ হয়েছে। এক মিনিট পরে আবার চেষ্টা করুন।',
}

function extractMessage(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.length < 10_000) {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        return extractMessage(parsed)
      } catch {
        return trimmed
      }
    }
    return trimmed
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>
    return extractMessage(obj.message ?? obj.error ?? obj.code ?? '')
  }
  return ''
}

export function sanitizeStudioError(value: unknown, status?: number): string {
  const raw = extractMessage(value)
  const code = raw.toLowerCase().replace(/\s+/g, '_')
  if (CODE_MESSAGES[code]) return CODE_MESSAGES[code]
  if (status === 401) return CODE_MESSAGES.unauthorized
  if (status === 403) return CODE_MESSAGES.forbidden
  if (status === 429 || /\b429\b|rate.?limit|too many requests/i.test(raw)) return CODE_MESSAGES.too_many_requests
  if (/out.?of.?credits|insufficient.?credit|balance.?too.?low/i.test(raw)) {
    return 'Provider balance শেষ বা কম। Settings-এর balance দেখে top-up করুন।'
  }
  if (/network|fetch failed|enotfound|econnrefused|econnreset|socket hang up/i.test(raw)) {
    return 'Provider-এর সাথে সংযোগ হচ্ছে না। একটু পরে Retry করুন।'
  }
  if (/timeout|timed out|aborterror/i.test(raw)) return 'Provider সময়মতো উত্তর দেয়নি। Retry করুন।'
  if (/content.?policy|safety|moderation/i.test(raw)) {
    return 'নিরাপত্তা নীতির কারণে অনুরোধটি চালানো যায়নি। ছবি বা নির্দেশনা বদলান।'
  }
  if (/qc.?failed|quality.?check/i.test(raw)) return CODE_MESSAGES.qc_failed_blocked

  // Preserve already-safe owner-facing Bangla, but never echo arbitrary
  // provider JSON, URLs, stack traces, SQL, or credential-shaped internals.
  const hasBangla = /[\u0980-\u09FF]/.test(raw)
  const looksInternal = /https?:\/\/|stack|trace|select\s|insert\s|api[_ -]?key|bearer\s|sk-[a-z0-9]|request[_ -]?id/i.test(raw)
  if (hasBangla && !looksInternal && raw.length <= 240) return raw
  return GENERIC_BN
}

export function studioErrorCodeMessage(code: string): string {
  return CODE_MESSAGES[code] ?? GENERIC_BN
}
