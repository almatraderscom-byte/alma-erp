// Minimal Meta Graph API client — no SDK dependency.

import { resilientFetch } from '@/agent/lib/fetch-retry'
import { agentStorageDownload } from '@/agent/lib/storage'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

function getPageToken(pageId: string): string | undefined {
  const tokens: Record<string, string | undefined> = {
    '1044848232034171': process.env.FB_PAGE_TOKEN_LIFESTYLE,
    '827260860637393': process.env.FB_PAGE_TOKEN_ONLINESHOP,
  }
  return tokens[pageId]
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
  const tok = getPageToken(pageId)
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

/** Resolve agent-files bucket object path from tool payload or signed URL. */
export function storagePathFromRef(ref: string): string | null {
  const normalized = ref.trim()
  if (!normalized || /^https?:\/\//i.test(normalized)) return null

  const fromObject = normalized.match(/\/object\/(?:sign\/)?agent-files\/([^?]+)/i)
  if (fromObject?.[1]) return decodeURIComponent(fromObject[1])

  if (/^(generated|uploads|general)\//.test(normalized)) return normalized

  // Chat uploads: <conversationId>/<timestamp>-<rand>.<ext>
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\//i.test(normalized)) {
    return normalized
  }

  // Fallback: any folder/file path in agent-files (e.g. general/1234-abc.png)
  if (/^[\w.-]+\/[\w.\-]+\.(png|jpe?g|webp|gif|pdf)$/i.test(normalized)) {
    return normalized
  }

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
  const storagePath = storagePathFromRef(ref)
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
      `Image not found for "${imageRef}". Use a valid agent-files path (general/..., generated/..., or conversation upload path).`,
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

// ── Live post/reel verification (staff submits a link or ID) ────────────────

export type FbRefKind = 'numeric' | 'reel' | 'video' | 'pfbid' | 'share' | 'unknown'

export interface ParsedFbRef {
  kind: FbRefKind
  /** Numeric object id when we could extract one (post_fbid / video / reel id). */
  id?: string
  /** Opaque token for pfbid / share / fb.watch links (cannot query Graph directly). */
  token?: string
  /** The original raw input, trimmed. */
  raw: string
  /** True when the source clearly indicated a reel/video (URL path). */
  looksVideo: boolean
}

/**
 * Parse a Facebook post/reel/video link or bare id into something we can verify.
 * Handles: /posts/<id>, /videos/<id>, /reel/<id>, watch/?v=<id>, permalink.php,
 * <pageId>_<postId>, bare numeric ids, and opaque pfbid / share / fb.watch links.
 */
export function parseFbPostRef(input: string): ParsedFbRef {
  const raw = String(input ?? '').trim()
  if (!raw) return { kind: 'unknown', raw, looksVideo: false }

  // Bare composite id already in graph form: <pageId>_<postId>
  if (/^\d+_\d+$/.test(raw)) return { kind: 'numeric', id: raw, raw, looksVideo: false }
  // Bare numeric id
  if (/^\d{6,}$/.test(raw)) return { kind: 'numeric', id: raw, raw, looksVideo: false }
  // Bare pfbid token
  if (/^pfbid[\w]+$/i.test(raw)) return { kind: 'pfbid', token: raw, raw, looksVideo: false }

  let url: URL | null = null
  try {
    url = new URL(raw)
  } catch {
    url = null
  }
  if (!url) return { kind: 'unknown', raw, looksVideo: false }

  const host = url.hostname.toLowerCase()
  const path = url.pathname
  const isFb = /(^|\.)facebook\.com$/.test(host) || /(^|\.)fb\.com$/.test(host)
  const isFbWatch = /(^|\.)fb\.watch$/.test(host)

  if (isFbWatch) {
    return { kind: 'share', token: path.replace(/\//g, '') || raw, raw, looksVideo: true }
  }
  if (!isFb) return { kind: 'unknown', raw, looksVideo: false }

  // share links: /share/r/<token>  /share/v/<token>  /share/p/<token>
  const share = path.match(/\/share\/([rvp])\/([\w-]+)/i)
  if (share) {
    return { kind: 'share', token: share[2], raw, looksVideo: share[1].toLowerCase() === 'r' || share[1].toLowerCase() === 'v' }
  }

  // reels: /reel/<id>
  const reel = path.match(/\/reel\/(\d+)/i)
  if (reel) return { kind: 'reel', id: reel[1], raw, looksVideo: true }

  // videos: /<page>/videos/<id>  or  /video.php?v=<id>  or  watch/?v=<id>
  const vidPath = path.match(/\/videos?\/(?:[^/]+\/)?(\d{6,})/i)
  if (vidPath) return { kind: 'video', id: vidPath[1], raw, looksVideo: true }
  const vParam = url.searchParams.get('v')
  if (vParam && /^\d{6,}$/.test(vParam)) return { kind: 'video', id: vParam, raw, looksVideo: true }

  // permalink.php?story_fbid=<id>&id=<pageId>
  const storyFbid = url.searchParams.get('story_fbid')
  const idParam = url.searchParams.get('id')
  if (storyFbid && /^\d+$/.test(storyFbid)) {
    const composite = idParam && /^\d+$/.test(idParam) ? `${idParam}_${storyFbid}` : storyFbid
    return { kind: 'numeric', id: composite, raw, looksVideo: false }
  }
  if (storyFbid && /^pfbid/i.test(storyFbid)) {
    return { kind: 'pfbid', token: storyFbid, raw, looksVideo: false }
  }

  // /<page>/posts/<id-or-pfbid>
  const post = path.match(/\/posts\/(pfbid[\w]+|\d+)/i)
  if (post) {
    if (/^pfbid/i.test(post[1])) return { kind: 'pfbid', token: post[1], raw, looksVideo: false }
    return { kind: 'numeric', id: post[1], raw, looksVideo: false }
  }

  // /<page>/photos/.../<id>
  const photo = path.match(/\/photos\/[^/]*\/?(\d{6,})/i)
  if (photo) return { kind: 'numeric', id: photo[1], raw, looksVideo: false }

  return { kind: 'unknown', raw, looksVideo: false }
}

export interface LivePostVerification {
  /** Post exists and is reachable on our page (ground truth). */
  ok: boolean
  /** Was matched to our page's content (graph id hit, or permalink match). */
  found: boolean
  isVideo: boolean
  isReel: boolean
  mediaType: string | null
  permalinkUrl: string | null
  createdTime: string | null
  /** Posted within the recency window (default 36h). */
  isRecent: boolean
  matchedBy: 'graph_id' | 'permalink' | 'none'
  note: string
}

function withinHours(iso: string | null | undefined, hours: number): boolean {
  if (!iso) return false
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= hours * 3_600_000
}

/** List recent reels for a page (best-effort; empty on error). */
async function getRecentReels(pageId: string, limit = 15): Promise<FbPost[]> {
  try {
    const token = tokenFor(pageId)
    const res = await resilientFetch(
      `${GRAPH_BASE}/${pageId}/video_reels?fields=id,created_time,permalink_url,description&limit=${Math.min(limit, 25)}&access_token=${token}`,
      { timeoutMs: 20_000, retries: 1 },
    )
    if (!res.ok) return []
    const data = (await res.json()) as { data?: FbPost[] }
    return data.data ?? []
  } catch {
    return []
  }
}

/**
 * Verify a staff-submitted Facebook post/reel link or id is GENUINELY live on our page.
 * Numeric ids are checked directly against the Graph API (strong, ground truth).
 * Opaque links (pfbid / share / fb.watch) are matched against the page's recent
 * posts + reels by permalink (weaker but still real — confirms it's our content).
 */
export async function verifyLivePost(opts: {
  pageId: string
  ref: string
  recentHours?: number
}): Promise<LivePostVerification> {
  const recentHours = opts.recentHours ?? 36
  const parsed = parseFbPostRef(opts.ref)
  const fail = (note: string): LivePostVerification => ({
    ok: false, found: false, isVideo: false, isReel: false, mediaType: null,
    permalinkUrl: null, createdTime: null, isRecent: false, matchedBy: 'none', note,
  })

  // Strong path: we have a numeric id → query Graph directly.
  if ((parsed.kind === 'numeric' || parsed.kind === 'video' || parsed.kind === 'reel') && parsed.id) {
    const token = tokenFor(opts.pageId)
    const graphId = parsed.id.includes('_') || parsed.kind !== 'numeric'
      ? parsed.id
      : `${opts.pageId}_${parsed.id}`
    const fields = 'id,permalink_url,created_time,status_type,attachments{media_type,type,description}'
    const res = await resilientFetch(
      `${GRAPH_BASE}/${graphId}?fields=${encodeURIComponent(fields)}&access_token=${token}`,
      { timeoutMs: 15_000, retries: 1 },
    )
    if (!res.ok) {
      return fail(`Post id ${parsed.id} could not be fetched from our page (Graph ${res.status}). It may be deleted, on another page, or private.`)
    }
    const data = (await res.json()) as {
      id?: string
      permalink_url?: string
      created_time?: string
      status_type?: string
      attachments?: { data?: Array<{ media_type?: string; type?: string }> }
    }
    if (!data.id) return fail('Post not found on our page.')
    const att = data.attachments?.data?.[0]
    const mediaType = att?.media_type ?? att?.type ?? (parsed.looksVideo ? 'video' : null)
    const isVideo = parsed.kind === 'reel' || parsed.kind === 'video' ||
      /video/i.test(mediaType ?? '') || data.status_type === 'added_video'
    const isReel = parsed.kind === 'reel'
    return {
      ok: true,
      found: true,
      isVideo,
      isReel,
      mediaType,
      permalinkUrl: data.permalink_url ?? null,
      createdTime: data.created_time ?? null,
      isRecent: withinHours(data.created_time, recentHours),
      matchedBy: 'graph_id',
      note: 'Verified live on our page via Graph API.',
    }
  }

  // Weak path: opaque link (pfbid / share / fb.watch). Match against recent content.
  const token = parsed.token ?? parsed.raw
  const [posts, reels] = await Promise.all([
    getRecentPosts({ pageId: opts.pageId, limit: 25 }).catch(() => [] as FbPost[]),
    getRecentReels(opts.pageId, 25),
  ])
  const all = [...reels.map((r) => ({ ...r, _reel: true })), ...posts.map((p) => ({ ...p, _reel: false }))]
  const norm = (s: string) => s.toLowerCase()
  const match = all.find((p) => {
    const perma = p.permalink_url ? norm(p.permalink_url) : ''
    return (
      (perma && token && perma.includes(norm(token))) ||
      (perma && perma.includes(norm(parsed.raw))) ||
      (token && perma && norm(parsed.raw).includes(perma))
    )
  })
  if (match) {
    return {
      ok: true,
      found: true,
      isVideo: Boolean((match as { _reel?: boolean })._reel) || parsed.looksVideo,
      isReel: Boolean((match as { _reel?: boolean })._reel),
      mediaType: (match as { _reel?: boolean })._reel ? 'video' : null,
      permalinkUrl: match.permalink_url ?? null,
      createdTime: match.created_time ?? null,
      isRecent: withinHours(match.created_time, recentHours),
      matchedBy: 'permalink',
      note: 'Matched against our page’s recent posts/reels by permalink.',
    }
  }
  return fail(
    parsed.kind === 'unknown'
      ? 'Could not understand this link. Ask staff for the post’s direct Facebook link or its numeric id.'
      : 'This share/pfbid link did not match any recent post or reel on our page. Ask for the direct post link.',
  )
}

export async function getRecentPosts(opts: {
  pageId: string
  limit?: number
}): Promise<FbPost[]> {
  const token = tokenFor(opts.pageId)
  const limit = Math.min(opts.limit ?? 10, 25)
  const res = await fetch(
    `${GRAPH_BASE}/${opts.pageId}/feed?fields=id,message,created_time,permalink_url&limit=${limit}&access_token=${token}`,
    { signal: AbortSignal.timeout(20_000) },
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
