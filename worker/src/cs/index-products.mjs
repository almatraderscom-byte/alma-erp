/**
 * Nightly / manual product visual indexing for CS-1.
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runCsIndexProducts() {
  console.log('[cs-index] starting product visual index...')
  const url = `${APP_URL()}/api/assistant/internal/cs-index-products`
  if (!APP_URL()) {
    return { dutyStatus: 'failed', dutyDetail: 'APP_URL not configured' }
  }

  let res
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INT_TOKEN()}`,
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(280_000),
    })
  } catch (err) {
    return { dutyStatus: 'failed', dutyDetail: `Network error: ${err.message?.slice(0, 200)}` }
  }

  const text = await res.text()
  let data
  try {
    data = JSON.parse(text)
  } catch {
    const preview = text.slice(0, 200).replace(/\n/g, ' ')
    return { dutyStatus: 'failed', dutyDetail: `HTTP ${res.status} — invalid JSON: ${preview}` }
  }

  if (!res.ok) {
    return { dutyStatus: 'failed', dutyDetail: `HTTP ${res.status}: ${data.error ?? JSON.stringify(data).slice(0, 200)}` }
  }

  console.log('[cs-index] done:', JSON.stringify(data))
  const count = data.indexed ?? data.count ?? '?'
  return {
    ...data,
    dutyStatus: 'done',
    dutyDetail: `${count}টি প্রোডাক্ট ইনডেক্স হয়েছে`,
  }
}
