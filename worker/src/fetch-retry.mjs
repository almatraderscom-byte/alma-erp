/**
 * Outbound fetch with timeout + one retry on transient errors.
 */

function isTransientStatus(status) {
  return status === 408 || status === 429 || status >= 500
}

export async function resilientFetch(url, options = {}) {
  const { timeoutMs = 30_000, retries = 1, ...init } = options
  let lastErr

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (!res.ok && isTransientStatus(res.status) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)))
        continue
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}
