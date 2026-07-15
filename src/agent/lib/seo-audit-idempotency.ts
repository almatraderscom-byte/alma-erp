import { createHash } from 'crypto'

export function normalizeAuditUrl(raw: string): string {
  try {
    const url = new URL(raw)
    url.hash = ''
    url.search = ''
    url.hostname = url.hostname.toLowerCase()
    url.pathname = url.pathname.replace(/\/+$/, '') || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return raw.trim().replace(/\/+$/, '').toLowerCase()
  }
}

/** Stable, index-safe key shared by all retries of one conversation+site audit. */
export function seoAuditDedupeKey(
  conversationId: string,
  normalizedUrl: string,
  requestScope = 'initial',
): string {
  return `seo_audit:${createHash('sha256').update(`${conversationId}\n${normalizedUrl}\n${requestScope}`).digest('hex')}`
}

function textFromStoredContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return ''
      const text = (block as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('\n')
}

/** A model-supplied force flag is accepted only when the latest owner text says so. */
export function ownerExplicitlyRequestedFreshAudit(content: unknown): boolean {
  const text = textFromStoredContent(content)
  const mentionsAudit = /(?:seo|audit|অডিট)/i.test(text)
  const asksFresh = /(?:re[\s-]?audit|fresh audit|audit again|again audit|after (?:the )?(?:fix|change)|আবার\s*(?:seo|audit|অডিট)|পুনর(?:ায়|ায়)\s*(?:seo|audit|অডিট)|নতুন করে\s*(?:seo|audit|অডিট)|ফিক্সের পর|পরিবর্তনের পর)/i.test(text)
  return mentionsAudit && asksFresh
}
