try {
  importScripts('https://cdn.onesignal.com/sdks/web/v16/OneSignalSDK.sw.js')
} catch (e) {
  // Keep core offline support alive even if the push CDN is unavailable.
}

const SHELL_CACHE = 'alma-erp-shell-v4'
const ASSET_CACHE = 'alma-erp-assets-v4'
const MAX_ASSET_ENTRIES = 72
const SHELL_ASSETS = ['/offline.html', '/manifest.json', '/icon.svg', '/maskable-icon.svg']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => ![SHELL_CACHE, ASSET_CACHE].includes(key)).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

async function trimCache(cacheName, maxEntries) {
  const cache = await caches.open(cacheName)
  const keys = await cache.keys()
  if (keys.length <= maxEntries) return
  await Promise.all(keys.slice(0, keys.length - maxEntries).map(key => cache.delete(key)))
}

function isStaticAsset(url) {
  return url.origin === self.location.origin && (
    url.pathname.startsWith('/_next/static/')
    || url.pathname === '/manifest.json'
    || url.pathname.endsWith('.svg')
    || url.pathname.endsWith('.png')
    || url.pathname.endsWith('.webp')
    || url.pathname.endsWith('.ico')
    || url.pathname.endsWith('.woff2')
  )
}

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api/')) return

  if (isStaticAsset(url)) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const clone = res.clone()
            caches.open(ASSET_CACHE)
              .then(cache => cache.put(req, clone))
              .then(() => trimCache(ASSET_CACHE, MAX_ASSET_ENTRIES))
              .catch(() => {})
          }
          return res
        })
        .catch(() => caches.match(req).then(cached => cached || Response.error())),
    )
    return
  }

  event.respondWith(
    fetch(req)
      .then(res => res)
      .catch(async () => {
        await new Promise(resolve => setTimeout(resolve, 500))
        try {
          return await fetch(req)
        } catch {
          if (req.mode === 'navigate') return caches.match('/offline.html')
          return Response.error()
        }
      }),
  )
})
