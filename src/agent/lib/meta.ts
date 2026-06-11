// Minimal Meta Graph API client — no SDK dependency.

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

const PAGE_TOKENS: Record<string, string | undefined> = {
  '1044848232034171': process.env.FB_PAGE_TOKEN_LIFESTYLE,
  '827260860637393': process.env.FB_PAGE_TOKEN_ONLINESHOP,
}

const PAGE_NAMES: Record<string, string> = {
  lifestyle: '1044848232034171',
  onlineshop: '827260860637393',
}

export function resolvePageId(page: string): string {
  return PAGE_NAMES[page.toLowerCase()] ?? page
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

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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
  const res = await fetch(
    `${GRAPH_BASE}/${graphId}?fields=id&access_token=${token}`,
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
