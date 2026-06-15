/**
 * Daily Meta page-token health check.
 * Verifies each configured page token with GET /me, alerts on failure.
 */

import { notify } from '../notify/index.mjs'

const PAGES = {
  '1044848232034171': { envKey: 'FB_PAGE_TOKEN_LIFESTYLE', name: 'Alma Lifestyle' },
  '827260860637393': { envKey: 'FB_PAGE_TOKEN_ONLINESHOP', name: 'Alma Online Shop' },
}

export async function checkPageTokenHealth() {
  console.log('[token-health] checking Meta page tokens...')
  const results = []

  for (const [pageId, { envKey, name }] of Object.entries(PAGES)) {
    const token = process.env[envKey]
    if (!token) {
      results.push({ pageId, name, ok: false, error: `${envKey} not set` })
      continue
    }
    try {
      const res = await fetch(
        `https://graph.facebook.com/v21.0/me?access_token=${token}`,
      )
      const data = await res.json()
      if (!res.ok) {
        results.push({ pageId, name, ok: false, error: data.error?.message ?? `HTTP ${res.status}` })
      } else {
        results.push({ pageId, name, ok: true })
      }
    } catch (err) {
      results.push({ pageId, name, ok: false, error: err.message })
    }
  }

  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    const lines = failed.map((f) => `• ${f.name} (${f.pageId}): ${f.error}`).join('\n')
    await notify({
      tier: 2,
      title: '⚠️ Facebook page token সমস্যা',
      message: `নিচের page token কাজ করছে না:\n${lines}\n\nMeta Business Settings থেকে নতুন token জেনারেট করুন।`,
      category: 'urgent',
    }).catch((err) => console.error('[token-health] notify failed:', err.message))
  }

  console.log(`[token-health] ${results.length} checked, ${failed.length} failed`)
  const detail = failed.length
    ? `${results.length} token চেক, ${failed.length} ব্যর্থ: ${failed.map(f => f.name).join(', ')}`
    : `${results.length} token সব OK`
  return { results, dutyStatus: 'done', dutyDetail: detail }
}
