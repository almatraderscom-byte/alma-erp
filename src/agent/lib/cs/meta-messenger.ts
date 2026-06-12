/**
 * Meta Messenger Send API — customer-facing only (CS pipeline).
 */
import { createHmac, timingSafeEqual } from 'crypto'

export const CS_PAGES: Record<string, { name: string; tokenEnv: string }> = {
  '1044848232034171': { name: 'Alma Lifestyle', tokenEnv: 'FB_PAGE_TOKEN_LIFESTYLE' },
  '827260860637393': { name: 'Alma Online Shop', tokenEnv: 'FB_PAGE_TOKEN_ONLINESHOP' },
}

export function pageAccessToken(pageId: string): string | null {
  const cfg = CS_PAGES[pageId]
  if (!cfg) return null
  return process.env[cfg.tokenEnv] ?? null
}

export function verifyMetaWebhookSignature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.META_APP_SECRET ?? ''
  if (!secret || !signatureHeader?.startsWith('sha256=')) return false
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')
  const provided = signatureHeader.slice(7)
  try {
    const a = Buffer.from(expected, 'hex')
    const b = Buffer.from(provided, 'hex')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

async function graphPost(path: string, token: string, body: Record<string, unknown>) {
  const res = await fetch(`https://graph.facebook.com/v21.0/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, access_token: token }),
  })
  const data = await res.json() as { error?: { message?: string }; message_id?: string }
  if (!res.ok) throw new Error(data.error?.message ?? `Graph API ${res.status}`)
  return data
}

export async function sendTypingOn(pageId: string, psid: string): Promise<void> {
  const token = pageAccessToken(pageId)
  if (!token) return
  await graphPost('me/messages', token, {
    recipient: { id: psid },
    sender_action: 'typing_on',
  }).catch(() => {})
}

export async function sendMessengerText(pageId: string, psid: string, text: string): Promise<string | undefined> {
  const token = pageAccessToken(pageId)
  if (!token) throw new Error(`No page token for ${pageId}`)
  const data = await graphPost('me/messages', token, {
    recipient: { id: psid },
    message: { text: text.slice(0, 2000) },
  })
  return data.message_id
}

export async function sendMessengerImage(pageId: string, psid: string, imageUrl: string, text?: string): Promise<void> {
  const token = pageAccessToken(pageId)
  if (!token) throw new Error(`No page token for ${pageId}`)
  if (text) await sendMessengerText(pageId, psid, text)
  await graphPost('me/messages', token, {
    recipient: { id: psid },
    message: {
      attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } },
    },
  })
}

export async function downloadMessengerAttachment(url: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Attachment download ${res.status}`)
  const mimeType = res.headers.get('content-type') ?? 'image/jpeg'
  const buffer = Buffer.from(await res.arrayBuffer())
  return { buffer, mimeType }
}

/** One private message per comment (Meta policy). */
export async function sendPrivateReplyToComment(
  pageId: string,
  commentId: string,
  message: string,
): Promise<void> {
  const token = pageAccessToken(pageId)
  if (!token) throw new Error(`No page token for ${pageId}`)
  await graphPost(`${commentId}/private_replies`, token, {
    message: message.slice(0, 2000),
  })
}

export async function sendPublicReplyToComment(
  pageId: string,
  commentId: string,
  message: string,
): Promise<void> {
  const token = pageAccessToken(pageId)
  if (!token) throw new Error(`No page token for ${pageId}`)
  await graphPost(`${commentId}/comments`, token, {
    message: message.slice(0, 500),
  })
}

export async function fetchPostImageUrl(pageId: string, postId: string): Promise<string | null> {
  const token = pageAccessToken(pageId)
  if (!token) return null
  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${postId}?fields=full_picture,attachments{media}&access_token=${token}`,
    )
    const data = await res.json() as {
      full_picture?: string
      attachments?: { data?: Array<{ media?: { image?: { src?: string } } }> }
    }
    return data.full_picture
      ?? data.attachments?.data?.[0]?.media?.image?.src
      ?? null
  } catch {
    return null
  }
}
