const QUOTA_PATTERNS = [
  /credit balance/i,
  /billing/i,
  /quota/i,
  /rate.?limit/i,
  /insufficient/i,
  /exceeded/i,
  /429/,
]

export function extractAnthropicRequestId(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const e = err as { request_id?: string; headers?: { get?: (k: string) => string | null } }
    if (e.request_id) return e.request_id
    if (e.headers?.get) return e.headers.get('request-id') ?? undefined
  }
  return undefined
}

export function isAnthropicQuotaExhausted(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return QUOTA_PATTERNS.some((p) => p.test(msg))
}

export function banglaAnthropicError(err: unknown): string {
  if (isAnthropicQuotaExhausted(err)) {
    return 'Anthropic API কোটা শেষ হয়ে গেছে। মালিককে জানানো হয়েছে — কিছুক্ষণ পরে আবার চেষ্টা করুন।'
  }
  const msg = err instanceof Error ? err.message : String(err)
  if (/overloaded|529/i.test(msg)) {
    return 'সার্ভার ব্যস্ত। কিছুক্ষণ পরে আবার চেষ্টা করুন।'
  }
  if (/timeout|abort/i.test(msg)) {
    return 'সময় শেষ — উত্তর পেতে ব্যর্থ। আবার চেষ্টা করুন।'
  }
  if (/api_key|authentication|401/i.test(msg)) {
    return 'API Key সেট করা নেই বা ভুল। Vercel-এ ANTHROPIC_API_KEY চেক করুন।'
  }
  return `একটি সমস্যা হয়েছে: ${msg.slice(0, 200)}`
}
