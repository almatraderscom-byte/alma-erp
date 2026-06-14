import { loadEnvFiles, requireEnv } from './env'

loadEnvFiles()

const GAS_TIMEOUT_MS = 120_000

function gasBaseUrl(): string {
  const fromEnv = process.env.NEXT_PUBLIC_API_URL?.trim()
  if (fromEnv) return fromEnv
  // Fallback: production deployment ID from config (no secret)
  return 'https://script.google.com/macros/s/AKfycbwa0DpWEpIKwUZdRkdWFU9Gv_MEtoB1p8mAOQGOOn21u9KZ1sAVZcD6yasI65rSlbSF/exec'
}

export async function gasGet<T extends Record<string, unknown>>(
  route: string,
  params: Record<string, string> = {},
): Promise<T> {
  const base = gasBaseUrl()
  const secret = requireEnv('API_SECRET')
  const url = new URL(base)
  url.searchParams.set('route', route)
  url.searchParams.set('secret', secret)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v)
  }

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), GAS_TIMEOUT_MS)
  try {
    const res = await fetch(url.toString(), { redirect: 'follow', signal: ctrl.signal })
    clearTimeout(timer)
    if (!res.ok) throw new Error(`GAS GET ${route} → HTTP ${res.status}`)
    const data = (await res.json()) as T & { error?: string }
    if (data.error) throw new Error(String(data.error))
    return data
  } catch (err) {
    clearTimeout(timer)
    throw err
  }
}
