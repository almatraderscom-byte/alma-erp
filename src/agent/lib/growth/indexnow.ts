/**
 * IndexNow — instant search-engine ping (Growth Feature 4).
 *
 * IndexNow is a keyless-OAuth protocol: you POST a list of changed URLs to a
 * single endpoint (api.indexnow.org), which fans the ping out to every
 * participating engine (Bing, Yandex, Seznam, Naver, …). Google does NOT
 * consume IndexNow, so real Google indexing still relies on the sitemap +
 * Search Console — IndexNow is the "tell everyone else instantly" layer.
 *
 * Verification model: the endpoint accepts the submission immediately (HTTP
 * 202, "validation pending") and later fetches https://{host}/{key}.txt to
 * confirm the caller owns the domain. That key file must live on the STOREFRONT
 * (almatraders.com is a separate deploy), so until the owner drops
 * `${INDEXNOW_KEY}.txt` into the storefront's public root the submission is
 * accepted but the URLs are not actually crawled. The ping itself always
 * succeeds — this module never touches the storefront repo.
 */

/** Public storefront origin — product detail pages live under /products/{slug}. */
export const STOREFRONT_ORIGIN = 'https://www.almatraders.com'
const STOREFRONT_HOST = 'www.almatraders.com'

/** IndexNow fan-out endpoint (broadcasts to all participating engines). */
const INDEXNOW_ENDPOINT = 'https://api.indexnow.org/indexnow'

/** IndexNow caps a single submission at 10,000 URLs; we stay well under. */
const MAX_URLS_PER_SUBMIT = 100

export type IndexNowResult =
  | {
      ok: true
      status: number
      submitted: string[]
      keyLocation: string
      /** true when the key file still needs to be hosted on the storefront. */
      keyValidationPending: boolean
      message: string
    }
  | { ok: false; error: string }

/** Read the configured IndexNow key (8–128 hex chars per spec). */
export function getIndexNowKey(): string | null {
  const key = (process.env.INDEXNOW_KEY ?? '').trim()
  return /^[a-f0-9]{8,128}$/i.test(key) ? key : null
}

/**
 * Normalise a caller-supplied target into a full storefront product URL.
 * Accepts a full https://www.almatraders.com/... URL, a "/products/slug" path,
 * or a bare product slug. Returns null for anything off-host / malformed.
 */
export function toStorefrontUrl(target: string): string | null {
  const t = target.trim()
  if (!t) return null
  if (/^https?:\/\//i.test(t)) {
    try {
      const u = new URL(t)
      return u.host === STOREFRONT_HOST ? u.toString() : null
    } catch {
      return null
    }
  }
  if (t.startsWith('/')) return `${STOREFRONT_ORIGIN}${t}`
  // bare slug → product detail page
  return `${STOREFRONT_ORIGIN}/products/${t}`
}

/**
 * Submit changed URLs to IndexNow. Requires INDEXNOW_KEY. Deduplicates,
 * validates host, and caps the batch. Never throws — returns a tagged result.
 */
export async function submitToIndexNow(targets: string[]): Promise<IndexNowResult> {
  const key = getIndexNowKey()
  if (!key) {
    return {
      ok: false,
      error:
        'INDEXNOW_KEY সেট করা নেই (৮–১২৮ hex char)। এটা env-এ যোগ করলে এবং storefront-এর root-এ ' +
        `${STOREFRONT_ORIGIN}/<key>.txt ফাইলটি রাখলে IndexNow কাজ করবে।`,
    }
  }

  const urls = Array.from(
    new Set(
      (targets ?? [])
        .map((t) => toStorefrontUrl(String(t)))
        .filter((u): u is string => Boolean(u)),
    ),
  ).slice(0, MAX_URLS_PER_SUBMIT)

  if (urls.length === 0) {
    return { ok: false, error: 'সাবমিট করার জন্য কোনো বৈধ almatraders.com URL পাওয়া যায়নি।' }
  }

  const keyLocation = `${STOREFRONT_ORIGIN}/${key}.txt`

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ host: STOREFRONT_HOST, key, keyLocation, urlList: urls }),
    })

    // 200 = accepted & validated, 202 = accepted, key validation pending.
    if (res.status !== 200 && res.status !== 202) {
      const body = await res.text().catch(() => '')
      return {
        ok: false,
        error: `IndexNow ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`,
      }
    }

    // Is the key file actually reachable on the storefront yet?
    let keyLive = false
    try {
      const check = await fetch(keyLocation, { method: 'GET' })
      keyLive = check.ok && (await check.text()).trim() === key
    } catch {
      keyLive = false
    }

    return {
      ok: true,
      status: res.status,
      submitted: urls,
      keyLocation,
      keyValidationPending: !keyLive,
      message: keyLive
        ? `${urls.length}টি URL IndexNow-তে সাবমিট হয়েছে (key verified ✅)।`
        : `${urls.length}টি URL IndexNow গ্রহণ করেছে (HTTP ${res.status})। তবে ${keyLocation} ` +
          'ফাইলটি storefront-এ এখনো নেই — owner এটা storefront-এর public root-এ রাখলে তবেই engine গুলো ' +
          'সত্যিকারের crawl শুরু করবে।',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `IndexNow submit ব্যর্থ: ${msg}` }
  }
}
