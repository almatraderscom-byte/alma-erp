export type AgentMarkdownLinkDestination =
  | { kind: 'internal'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'invalid' }

const MAX_HREF_CHARS = 4_096
const UNSAFE_HREF_CHAR = /[\u0000-\u001f\u007f\\]/

function internalDestination(href: string): AgentMarkdownLinkDestination {
  try {
    const pathname = new URL(href, 'https://alma.invalid').pathname
    // Chat-authored links are navigation only. API routes may read private data
    // and must never become clickable/prefetchable GET destinations.
    if (pathname === '/api' || pathname.startsWith('/api/')) return { kind: 'invalid' }
  } catch {
    return { kind: 'invalid' }
  }
  return { kind: 'internal', href }
}

/**
 * Classify a model-authored Markdown href before it reaches a clickable element.
 *
 * ALMA links are generated as root-relative paths and stay in the current app.
 * Absolute links are external unless they match the browser's exact current
 * origin. Only HTTP(S) is allowed; custom/data/script schemes and protocol-
 * relative URLs fail closed.
 */
export function classifyAgentMarkdownHref(
  href: string | null | undefined,
  currentOrigin?: string,
): AgentMarkdownLinkDestination {
  if (typeof href !== 'string') return { kind: 'invalid' }
  const raw = href.trim()
  if (!raw || raw.length > MAX_HREF_CHARS || UNSAFE_HREF_CHAR.test(raw)) {
    return { kind: 'invalid' }
  }

  if (raw.startsWith('/')) {
    return raw.startsWith('//')
      ? { kind: 'invalid' }
      : internalDestination(raw)
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { kind: 'invalid' }
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    return { kind: 'invalid' }
  }
  // Credentials inside a chat link are both unnecessary and visually deceptive.
  if (url.username || url.password) return { kind: 'invalid' }

  if (currentOrigin) {
    try {
      const origin = new URL(currentOrigin).origin
      if (url.origin === origin) {
        return internalDestination(`${url.pathname || '/'}${url.search}${url.hash}`)
      }
    } catch {
      // A malformed caller origin cannot make an otherwise-external URL internal.
    }
  }

  return { kind: 'external', href: raw }
}
