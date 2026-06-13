/**
 * Alma ERP service worker — v7
 * IMPORTANT: Do NOT cache /_next/static/* — stale chunks cause blank screens after deploy.
 *
 * OneSignal web push SDK: used only when PwaBootstrap registers this SW (browser/PWA).
 * Capacitor native shell skips SW registration — native push uses @onesignal/capacitor-plugin.
 */
try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js')
} catch {
  // Push CDN optional — offline shell still works.
}

const SW_VERSION = 'v7'
const SHELL_CACHE = `alma-erp-shell-${SW_VERSION}`
const ICON_CACHE = `alma-erp-icons-${SW_VERSION}`
const SHELL_ASSETS = ['/offline.html', '/manifest.json', '/icon.svg', '/maskable-icon.svg']

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

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)

  if (url.pathname.startsWith('/api/')) return

  // Never cache Next.js build chunks — prevents post-deploy blank pages.
  if (url.pathname.startsWith('/_next/')) return

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match('/offline.html')
        return cached || Response.error()
      }),
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
