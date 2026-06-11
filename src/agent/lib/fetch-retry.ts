/**
 * Outbound HTTP with timeout + one retry on transient failures.
 */

export type ResilientFetchOptions = RequestInit & {
  timeoutMs?: number
  retries?: number
}

function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500
}

export async function resilientFetch(
  url: string,
  options: ResilientFetchOptions = {},
): Promise<Response> {
  const { timeoutMs = 30_000, retries = 1, ...init } = options
  let lastErr: unknown

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
