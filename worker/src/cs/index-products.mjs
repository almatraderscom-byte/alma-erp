/**
 * Nightly / manual product visual indexing for CS-1.
 */
const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

export async function runCsIndexProducts() {
  console.log('[cs-index] starting product visual index...')
  const res = await fetch(`${APP_URL()}/api/assistant/internal/cs-index-products`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({}),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  console.log('[cs-index] done:', JSON.stringify(data))
  const count = data.indexed ?? data.count ?? '?'
  return {
    ...data,
    dutyStatus: 'done',
    dutyDetail: `${count}টি প্রোডাক্ট ইনডেক্স হয়েছে`,
  }
}
