const CACHE_NAME = 'alma-erp-shell-v1'
const SHELL_ASSETS = ['/', '/login', '/offline.html', '/manifest.json', '/icon.svg', '/maskable-icon.svg']

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', event => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.pathname.startsWith('/api/')) return

  event.respondWith(
    fetch(req)
      .then(res => {
        const clone = res.clone()
        if (res.ok && req.mode === 'navigate') {
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone)).catch(() => {})
        }
        return res
      })
      .catch(async () => {
        const cached = await caches.match(req)
        if (cached) return cached
        if (req.mode === 'navigate') return caches.match('/offline.html')
        return Response.error()
      }),
  )
})
