/** Abort fetch after `ms` — prevents infinite hangs on slow WiFi. */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  ms = 8_000,
): Promise<Response> {
  if (ms <= 0 || typeof AbortController === 'undefined') {
    return fetch(input, init)
  }
  const controller = new AbortController()
  const outer = init.signal
  if (outer) {
    if (outer.aborted) controller.abort()
    else outer.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}
