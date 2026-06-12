// Minimal Meta Graph API client — no SDK dependency.

import { resilientFetch } from '@/agent/lib/fetch-retry'
import { agentStorageDownload } from '@/agent/lib/storage'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

const PAGE_TOKENS: Record<string, string | undefined> = {
  '1044848232034171': process.env.FB_PAGE_TOKEN_LIFESTYLE,
  '827260860637393': process.env.FB_PAGE_TOKEN_ONLINESHOP,
}

const PAGE_NAMES: Record<string, string> = {
  lifestyle: '1044848232034171',
  onlineshop: '827260860637393',
}

const PAGE_LABELS: Record<string, string> = {
  '1044848232034171': 'Alma Lifestyle',
  '827260860637393': 'Alma Online Shop',
}

export function resolvePageId(page: string): string {
  return PAGE_NAMES[page.toLowerCase()] ?? page
}

export function pageLabel(pageId: string): string {
  return PAGE_LABELS[pageId] ?? pageId
}

function tokenFor(pageId: string): string {
  const tok = PAGE_TOKENS[pageId]
  if (!tok) throw new Error(`No FB_PAGE_TOKEN configured for page ${pageId}`)
  return tok
}

export interface FbPost {
  id: string
  message?: string
  created_time?: string
  permalink_url?: string
}

/** Normalize image ref from agent payload — rejects empty / literal "null". */
export function normalizeFbImageRef(raw: unknown): string | undefined {
  if (raw == null) return undefined
  let s = String(raw).trim().replace(/^`|`$/g, '').trim()
  if (!s || s === 'null' || s === 'undefined' || s === 'none') return undefined
  return s
}

function storagePathFromRef(ref: string): string | null {
  if (/^(generated|uploads)\//.test(ref)) return ref
  const fromObject = ref.match(/\/object\/(?:sign\/)?agent-files\/([^?]+)/i)
  if (fromObject?.[1]) return decodeURIComponent(fromObject[1])
  return null
}

function mimeFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'webp') return 'image/webp'
  if (ext === 'gif') return 'image/gif'
  return 'image/jpeg'
}

async function postFeedText(pageId: string, token: string, message: string): Promise<string> {
  const res = await resilientFetch(`${GRAPH_BASE}/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, access_token: token }),
    timeoutMs: 30_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { id?: string; post_id?: string }
  return data.post_id ?? data.id ?? ''
}

async function postPhotoBuffer(
  pageId: string,
  token: string,
  message: string,
  buffer: Buffer,
  contentType: string,
): Promise<string> {
  const form = new FormData()
  form.append('message', message)
  form.append('access_token', token)
  const ext = contentType.split('/')[1] || 'jpg'
  form.append('source', new Blob([new Uint8Array(buffer)], { type: contentType }), `post.${ext}`)

  const res = await resilientFetch(`${GRAPH_BASE}/${pageId}/photos`, {
    method: 'POST',
    body: form,
    timeoutMs: 60_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { id?: string; post_id?: string }
  return data.post_id ?? data.id ?? ''
}

async function postPhotoByUrl(
  pageId: string,
  token: string,
  message: string,
  imageUrl: string,
): Promise<string> {
  const res = await resilientFetch(`${GRAPH_BASE}/${pageId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, url: imageUrl, access_token: token }),
    timeoutMs: 30_000,
    retries: 1,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { id?: string; post_id?: string }
  return data.post_id ?? data.id ?? ''
}

async function loadImageBytes(ref: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const storagePath = storagePathFromRef(ref) ?? (/^(generated|uploads)\//.test(ref) ? ref : null)
  if (storagePath) {
    const buffer = await agentStorageDownload(storagePath)
    return { buffer, contentType: mimeFromPath(storagePath) }
  }

  if (/^https?:\/\//i.test(ref)) {
    const res = await resilientFetch(ref, { timeoutMs: 30_000, retries: 1 })
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') || 'image/jpeg'
    const buffer = Buffer.from(await res.arrayBuffer())
    if (!buffer.length) return null
    return { buffer, contentType }
  }

  return null
}

export async function createPagePost(opts: {
  pageId: string
  message: string
  imageUrl?: string
  /** When true, refuse caption-only posts (image expected). */
  requireImage?: boolean
}): Promise<{ postId: string; permalinkUrl?: string; postedAsPhoto: boolean }> {
  const token = tokenFor(opts.pageId)
  const imageRef = normalizeFbImageRef(opts.imageUrl)

  if (!imageRef) {
    if (opts.requireImage) {
      throw new Error(
        'ছবি পাওয়া যায়নি — শুধু ক্যাপশন পোস্ট করা হয়নি। আগে generate_image approve করুন, তারপর আবার post করুন।',
      )
    }
    const postId = await postFeedText(opts.pageId, token, opts.message)
    return { postId, postedAsPhoto: false }
  }

  try {
    const loaded = await loadImageBytes(imageRef)
    if (loaded) {
      const postId = await postPhotoBuffer(
        opts.pageId,
        token,
        opts.message,
        loaded.buffer,
        loaded.contentType,
      )
      return { postId, postedAsPhoto: true }
    }

    if (/^https?:\/\//i.test(imageRef)) {
      const postId = await postPhotoByUrl(opts.pageId, token, opts.message, imageRef)
      return { postId, postedAsPhoto: true }
    }

    throw new Error(
      `Image not found for "${imageRef}". Approve image generation first, then pass storage path like generated/<id>.png in post_to_facebook.`,
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('324') || msg.toLowerCase().includes('missing file')) {
      throw new Error(
        'Facebook could not load the image file. Ensure generate_image is approved and imageArtifactOrFileId is the Supabase path (generated/...).',
      )
    }
    throw err
  }
}

export interface FbPostVerification {
  ok: boolean
  hasMedia: boolean
  statusType?: string
}

export async function verifyPost(pageId: string, postId: string): Promise<FbPostVerification> {
  const token = tokenFor(pageId)
  const graphId = postId.includes('_') ? postId : `${pageId}_${postId}`
  const res = await resilientFetch(
    `${GRAPH_BASE}/${graphId}?fields=id,full_picture,attachments,status_type&access_token=${token}`,
    { timeoutMs: 15_000, retries: 1 },
  )
  if (!res.ok) return { ok: false, hasMedia: false }
  const data = (await res.json()) as {
    id?: string
    full_picture?: string
    status_type?: string
    attachments?: { data?: unknown[] }
  }
  const hasMedia = Boolean(
    data.full_picture ||
    data.attachments?.data?.length ||
    data.status_type === 'added_photos',
  )
  return {
    ok: Boolean(data.id),
    hasMedia,
    statusType: data.status_type,
  }
}

export async function getRecentPosts(opts: {
  pageId: string
  limit?: number
}): Promise<FbPost[]> {
  const token = tokenFor(opts.pageId)
  const limit = Math.min(opts.limit ?? 10, 25)
  const res = await fetch(
    `${GRAPH_BASE}/${opts.pageId}/feed?fields=id,message,created_time,permalink_url&limit=${limit}&access_token=${token}`,
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status}: ${err}`)
  }
  const data = (await res.json()) as { data?: FbPost[] }
  return data.data ?? []
}

type RawFbMessage = {
  id?: string
  from?: { id?: string; name?: string }
  message?: string
  created_time?: string
  attachments?: { data?: unknown[] }
}

type RawFbConversation = {
  id: string
  updated_time?: string
  messages?: { data?: RawFbMessage[] }
}

export interface FbMessengerThread {
  conversationId: string
  updatedTime: string | null
  lastMessage: {
    from: 'customer' | 'page'
    senderName: string | null
    text: string
    createdTime: string
    hasAttachment: boolean
  } | null
  unansweredMinutes: number | null
  needsReply: boolean
}

export async function getMessengerInbox(opts: {
  pageId: string
  limit?: number
}): Promise<FbMessengerThread[]> {
  const token = tokenFor(opts.pageId)
  const limit = Math.min(Math.max(opts.limit ?? 15, 1), 25)
  const fields = encodeURIComponent(
    'id,updated_time,messages{id,from,message,created_time,attachments}',
  )
  const res = await resilientFetch(
    `${GRAPH_BASE}/${opts.pageId}/conversations?fields=${fields}&limit=${limit}&access_token=${token}`,
    { timeoutMs: 30_000, retries: 1 },
  )
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status}: ${err}`)
  }

  const payload = (await res.json()) as { data?: RawFbConversation[] }
  const now = Date.now()

  return (payload.data ?? []).map((conv) => {
    const messages = [...(conv.messages?.data ?? [])].sort(
      (a, b) => new Date(a.created_time ?? 0).getTime() - new Date(b.created_time ?? 0).getTime(),
    )
    const last = messages[messages.length - 1]
    const fromCustomer = last?.from?.id !== opts.pageId
    const createdMs = last?.created_time ? new Date(last.created_time).getTime() : null
    const unansweredMinutes =
      fromCustomer && createdMs
        ? Math.max(0, Math.round((now - createdMs) / 60_000))
        : null

    return {
      conversationId: conv.id,
      updatedTime: conv.updated_time ?? null,
      lastMessage: last
        ? {
            from: fromCustomer ? 'customer' : 'page',
            senderName: last.from?.name ?? null,
            text: (last.message?.trim() || (last.attachments?.data?.length ? '(attachment)' : '(no text)')),
            createdTime: last.created_time ?? '',
            hasAttachment: Boolean(last.attachments?.data?.length),
          }
        : null,
      unansweredMinutes,
      needsReply: Boolean(fromCustomer && unansweredMinutes !== null && unansweredMinutes >= 30),
    }
  })
}
