// Minimal Meta Graph API client — no SDK dependency.

import { resilientFetch } from '@/agent/lib/fetch-retry'

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

export async function createPagePost(opts: {
  pageId: string
  message: string
  imageUrl?: string
}): Promise<{ postId: string; permalinkUrl?: string }> {
  const token = tokenFor(opts.pageId)
  const endpoint = opts.imageUrl
    ? `${GRAPH_BASE}/${opts.pageId}/photos`
    : `${GRAPH_BASE}/${opts.pageId}/feed`

  const body: Record<string, string> = { message: opts.message, access_token: token }
  if (opts.imageUrl) body.url = opts.imageUrl

  const res = await resilientFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
    retries: 1,
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Graph API error ${res.status}: ${err}`)
  }

  const data = (await res.json()) as { id?: string; post_id?: string }
  const postId = data.post_id ?? data.id ?? ''
  return { postId }
}

export async function verifyPost(pageId: string, postId: string): Promise<boolean> {
  const token = tokenFor(pageId)
  // Graph postId for feed posts is "pageId_postId"
  const graphId = postId.includes('_') ? postId : `${pageId}_${postId}`
  const res = await resilientFetch(
    `${GRAPH_BASE}/${graphId}?fields=id&access_token=${token}`,
    { timeoutMs: 15_000, retries: 1 },
  )
  if (!res.ok) return false
  const data = (await res.json()) as { id?: string }
  return Boolean(data.id)
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
