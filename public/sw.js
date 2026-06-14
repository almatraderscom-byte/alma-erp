/**
 * Alma ERP service worker — v10
 * IMPORTANT: Do NOT cache /_next/static/* — stale chunks cause blank screens after deploy.
 *
 * Navigation uses a hard timeout so slow WiFi cannot hang the app behind the boot splash.
 */
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js')
} catch {
  // Push CDN optional — offline shell still works.
}

const SW_VERSION = 'v10'
const SHELL_CACHE = `alma-erp-shell-${SW_VERSION}`
const ICON_CACHE = `alma-erp-icons-${SW_VERSION}`
const SHELL_ASSETS = ['/offline.html', '/manifest.json', '/icon.svg', '/maskable-icon.svg', '/sounds/alma-notification.mp3']
const NAV_FETCH_TIMEOUT_MS = 12_000

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => ![SHELL_CACHE, ICON_CACHE].includes(key))
          .map(key => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  )
})

function isIconAsset(url) {
  return url.origin === self.location.origin && (
    url.pathname === '/manifest.json'
    || url.pathname.endsWith('.svg')
    || url.pathname.endsWith('.png')
    || url.pathname.endsWith('.webp')
    || url.pathname.endsWith('.ico')
  )
}

async function fetchNavigateWithTimeout(req) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), NAV_FETCH_TIMEOUT_MS)
  try {
    return await fetch(req, { signal: controller.signal, cache: 'no-store' })
  } catch {
    await new Promise(resolve => setTimeout(resolve, 400))
    try {
      return await fetch(req, { cache: 'no-store' })
    } catch {
      const cached = await caches.match('/offline.html')
      if (cached) return cached
      return Response.error()
    }
  } finally {
    clearTimeout(timer)
  }
}

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  if (url.pathname.startsWith('/api/')) return

  // Never cache Next.js build chunks — prevents post-deploy blank pages.
  if (url.pathname.startsWith('/_next/')) return

  if (req.mode === 'navigate') {
    event.respondWith(fetchNavigateWithTimeout(req))
    return
  }

  if (url.pathname === '/sounds/alma-notification.mp3') {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(SHELL_CACHE).then(cache => cache.put(req, clone)).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match(req).then(cached => cached || Response.error())),
    )
    return
  }

  if (isIconAsset(url)) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(ICON_CACHE).then(cache => cache.put(req, clone)).catch(() => {})
          }
          return res
        })
        .catch(() => caches.match(req).then(cached => cached || Response.error())),
    )
  }
})

/** Play custom Alma tone in open tabs when a push arrives (Web/PWA). */
self.addEventListener('push', event => {
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        client.postMessage({ type: 'ALMA_PLAY_NOTIFICATION_SOUND' })
      }
    }),
  )
})
