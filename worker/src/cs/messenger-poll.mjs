/**
 * Inbox poll fallback — Meta webhooks often skip real customers when the app is in
 * Development mode or delivery fails. Only ingests RECENT UNANSWERED customer messages
 * (latest message in thread must be from customer, within max age).
 */
const PAGES = [
  { id: '1044848232034171', name: 'Alma Lifestyle', envKey: 'FB_PAGE_TOKEN_LIFESTYLE' },
  { id: '827260860637393', name: 'Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP' },
]

/** Only messages newer than this are candidates (hours). */
const MAX_MESSAGE_AGE_MS = Number(process.env.CS_POLL_MAX_AGE_HOURS ?? 4) * 60 * 60 * 1000

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
      messageCreatedAt: msg.created_time,
      source: 'poll',
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
  let skipped = 0
  const fields = encodeURIComponent('participants,messages.limit(3){id,message,from,created_time,attachments}')
  const now = Date.now()

  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) {
      console.warn(`[cs-messenger-poll] skip ${page.name} — no token`)
      continue
    }

    try {
      const data = await fbGet(`${page.id}/conversations?fields=${fields}&limit=10`, token)
      for (const conv of data.data ?? []) {
        const messages = conv.messages?.data ?? []
        if (!messages.length) continue

        // Graph returns newest first — if page replied last, thread is done.
        const latest = messages[0]
        if (latest.from?.id === page.id) {
          skipped++
          continue
        }

        const ageMs = now - new Date(latest.created_time).getTime()
        if (!Number.isFinite(ageMs) || ageMs > MAX_MESSAGE_AGE_MS) {
          skipped++
          continue
        }

        try {
          const result = await syncMessage(page, latest)
          if (result.ingested && result.jobQueued) ingested++
          else skipped++
        } catch (err) {
          console.warn(`[cs-messenger-poll] sync failed ${page.name} ${latest.id}:`, err.message)
        }
      }
    } catch (err) {
      console.error(`[cs-messenger-poll] ${page.name} error:`, err.message)
    }
  }

  if (ingested > 0) console.log(`[cs-messenger-poll] ingested ${ingested} unanswered message(s), skipped ${skipped}`)
  return { ingested, skipped }
}
