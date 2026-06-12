/**
 * Inbox poll fallback — Meta webhooks often skip real customers when the app is in
 * Development mode or delivery fails. Reads recent Page inbox via Graph API and
 * ingests any customer messages missing from cs_messages.
 */
const PAGES = [
  { id: '1044848232034171', name: 'Alma Lifestyle', envKey: 'FB_PAGE_TOKEN_LIFESTYLE' },
  { id: '827260860637393', name: 'Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP' },
]

const APP_URL = () => process.env.APP_URL?.replace(/\/$/, '') ?? ''
const INT_TOKEN = () => process.env.AGENT_INTERNAL_TOKEN ?? ''

async function fbGet(path, token) {
  const url = `https://graph.facebook.com/v21.0/${path}&access_token=${encodeURIComponent(token)}`
  const res = await fetch(url)
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`FB API ${res.status}: ${err.slice(0, 200)}`)
  }
  return res.json()
}

async function syncMessage(page, msg) {
  const psid = msg.from?.id
  if (!psid || psid === page.id) return { skipped: true }

  const imageUrls = (msg.attachments?.data ?? [])
    .filter((a) => a.mime_type?.startsWith('image/') || a.image_data || a.type === 'image')
    .map((a) => a.image_data?.url || a.file_url)
    .filter(Boolean)

  const res = await fetch(`${APP_URL()}/api/assistant/internal/messenger-sync`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${INT_TOKEN()}`,
    },
    body: JSON.stringify({
      pageId: page.id,
      psid,
      mid: msg.id,
      text: msg.message ?? '',
      imageUrls,
      customerName: msg.from?.name,
    }),
  })

  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `sync HTTP ${res.status}`)
  return data
}

export async function pollMessengerInbox() {
  if (!APP_URL() || !INT_TOKEN()) {
    console.warn('[cs-messenger-poll] APP_URL or AGENT_INTERNAL_TOKEN missing — skip')
    return { ingested: 0 }
  }

  let ingested = 0
  const fields = encodeURIComponent('participants,messages.limit(8){id,message,from,created_time,attachments}')

  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) {
      console.warn(`[cs-messenger-poll] skip ${page.name} — no token`)
      continue
    }

    try {
      const data = await fbGet(`${page.id}/conversations?fields=${fields}&limit=15`, token)
      for (const conv of data.data ?? []) {
        const messages = conv.messages?.data ?? []
        for (const msg of messages) {
          try {
            const result = await syncMessage(page, msg)
            if (result.ingested && result.jobQueued) ingested++
          } catch (err) {
            console.warn(`[cs-messenger-poll] sync failed ${page.name} ${msg.id}:`, err.message)
          }
        }
      }
    } catch (err) {
      console.error(`[cs-messenger-poll] ${page.name} error:`, err.message)
    }
  }

  if (ingested > 0) console.log(`[cs-messenger-poll] ingested ${ingested} new message(s)`)
  return { ingested }
}
