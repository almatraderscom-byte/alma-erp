/**
 * Telegram API proxy — global fetch interception.
 *
 * Some VPS providers (e.g. Hostinger) block outbound TLS to api.telegram.org
 * via SNI-based DPI. To work around this without changing every fetch call
 * site, we monkey-patch global fetch on worker startup to redirect any URL
 * starting with `https://api.telegram.org` to the configured proxy base.
 *
 * Set env var TELEGRAM_API_BASE to point at a Cloudflare Worker / nginx /
 * any HTTPS proxy that forwards to the real Telegram Bot API.
 *
 * Example:  TELEGRAM_API_BASE=https://tg-proxy.almatraders.workers.dev
 *
 * If TELEGRAM_API_BASE is unset or equals https://api.telegram.org, this
 * is a no-op and existing direct calls keep working.
 */

const REAL_BASE = 'https://api.telegram.org'

export function installTelegramProxy() {
  const proxyBase = (process.env.TELEGRAM_API_BASE ?? '').replace(/\/$/, '')
  if (!proxyBase || proxyBase === REAL_BASE) {
    console.log('[telegram-proxy] direct mode (TELEGRAM_API_BASE not set)')
    return
  }

  console.log(`[telegram-proxy] redirecting ${REAL_BASE} → ${proxyBase}`)

  const origFetch = globalThis.fetch.bind(globalThis)

  globalThis.fetch = async (input, init) => {
    let url = ''
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else if (input instanceof Request) {
      url = input.url
    }

    if (url && url.startsWith(REAL_BASE)) {
      const rewritten = proxyBase + url.slice(REAL_BASE.length)
      if (typeof input === 'string') {
        return origFetch(rewritten, init)
      }
      if (input instanceof URL) {
        return origFetch(new URL(rewritten), init)
      }
      // Request object: clone with new URL (init takes precedence over Request props)
      return origFetch(rewritten, { ...input, ...init })
    }

    return origFetch(input, init)
  }
}
