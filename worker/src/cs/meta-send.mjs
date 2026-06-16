/**
 * Meta Messenger send helpers (worker-side duplicate of app meta-messenger).
 */
import { resilientFetch } from '../fetch-retry.mjs'

const PAGES = {
  '1044848232034171': 'FB_PAGE_TOKEN_LIFESTYLE',
  '827260860637393': 'FB_PAGE_TOKEN_ONLINESHOP',
}

function token(pageId) {
  const envKey = PAGES[pageId]
  return envKey ? process.env[envKey] : null
}

async function graphPost(path, accessToken, body) {
  const res = await resilientFetch(`https://graph.facebook.com/v21.0/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: accessToken }),
    timeoutMs: 15_000,
    retries: 1,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message ?? `Graph ${res.status}`)
  return data
}

export async function sendTypingOn(pageId, psid) {
  const t = token(pageId)
  if (!t) return
  await graphPost('me/messages', t, { recipient: { id: psid }, sender_action: 'typing_on' }).catch(() => {})
}

export async function sendMessengerText(pageId, psid, text) {
  const t = token(pageId)
  if (!t) throw new Error(`No token for page ${pageId}`)
  return graphPost('me/messages', t, {
    recipient: { id: psid },
    message: { text: text.slice(0, 2000) },
  })
}

export async function sendMessengerImage(pageId, psid, imageUrl, caption) {
  const t = token(pageId)
  if (!t) throw new Error(`No token for page ${pageId}`)
  if (caption) await sendMessengerText(pageId, psid, caption)
  return graphPost('me/messages', t, {
    recipient: { id: psid },
    message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } },
  })
}
