/**
 * Instagram Graph API — publish a single-image feed post to ALMA's Instagram
 * Business account (the one linked to the Facebook page).
 *
 * Every publish is a real, PUBLIC, irreversible side-effect, so callers ALWAYS
 * stage it behind an owner confirm card — the exact mirror of post_to_facebook →
 * the `fb_post` approval handler. Nothing here posts without an approved card.
 *
 * Two important differences from the Facebook /photos path:
 *  1. IG's Content Publishing API does NOT accept binary uploads. It fetches a
 *     PUBLIC media URL server-side. Our creatives live in the PRIVATE agent-files
 *     bucket, so we mint a short-lived signed URL (agentStorageSignedUrl) that
 *     Meta fetches during container creation.
 *  2. Publishing is two calls: create a media *container* (POST /{ig-user}/media)
 *     then publish it (POST /{ig-user}/media_publish with creation_id).
 *
 * Scope (Phase 4): single-image feed posts only — synchronous and fast (two API
 * calls), safe inside a Vercel function. Reels/video need async container status
 * polling (often >30s) which, per the project's architecture rule, belongs on the
 * VPS worker queue — deliberately deferred to a follow-up, not done here.
 */
import { resilientFetch } from '@/agent/lib/fetch-retry'
import { agentStorageSignedUrl } from '@/agent/lib/storage'
import { normalizeFbImageRef, storagePathFromRef } from '@/agent/lib/meta'

const GRAPH_BASE = 'https://graph.facebook.com/v21.0'

/**
 * Mirror of the page-token map in meta.ts (same env vars). Kept local so this
 * publish path doesn't widen meta.ts's exported surface — the same deliberate
 * duplication pattern meta-audiences.ts uses for the page-id map.
 */
function pageToken(pageId: string): string {
  const tokens: Record<string, string | undefined> = {
    '1044848232034171': process.env.FB_PAGE_TOKEN_LIFESTYLE,
    '827260860637393': process.env.FB_PAGE_TOKEN_ONLINESHOP,
  }
  const tok = tokens[pageId]
  if (!tok) throw new Error(`No FB_PAGE_TOKEN configured for page ${pageId}`)
  return tok
}

export interface IgAccount {
  igUserId: string
  username?: string
}

/**
 * Resolve the Instagram Business account id linked to a Facebook page. The page
 * token is the same one used to post to the page. Returns a clear Bangla error if
 * no IG account is linked (a common owner-side setup gap).
 */
export async function getInstagramAccount(
  pageId: string,
): Promise<{ success: boolean; account?: IgAccount; error?: string }> {
  try {
    const token = pageToken(pageId)
    const params = new URLSearchParams({
      fields: 'instagram_business_account{id,username}',
      access_token: token,
    })
    const res = await resilientFetch(`${GRAPH_BASE}/${pageId}?${params.toString()}`, {
      timeoutMs: 20_000,
      retries: 1,
    })
    const text = await res.text()
    if (!res.ok) return { success: false, error: `IG account fetch ${res.status}: ${text.slice(0, 200)}` }
    const data = JSON.parse(text) as { instagram_business_account?: { id?: string; username?: string } }
    const ig = data.instagram_business_account
    if (!ig?.id) {
      return {
        success: false,
        error:
          'এই Facebook পেজের সাথে কোনো Instagram Business অ্যাকাউন্ট লিংক করা নেই। (Meta Business Suite → Settings → Linked accounts থেকে Instagram যুক্ত করুন।)',
      }
    }
    return { success: true, account: { igUserId: ig.id, username: ig.username } }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve an image ref (a private-bucket storage path OR an already-public http
 * url) into a PUBLIC url Instagram can fetch. Storage paths are signed for 1h —
 * Meta fetches within seconds during container creation, so the short TTL is fine
 * and avoids leaving a long-lived public link.
 */
async function toPublicMediaUrl(ref: string): Promise<string> {
  const norm = normalizeFbImageRef(ref)
  if (!norm) throw new Error('ছবির path পাওয়া যায়নি।')
  if (/^https?:\/\//i.test(norm)) return norm
  const storagePath = storagePathFromRef(norm)
  if (!storagePath) {
    throw new Error(
      `ছবির path বুঝতে পারিনি: "${norm}" — generated/<id>.png বা chat upload path দিন।`,
    )
  }
  return agentStorageSignedUrl(storagePath, 3600)
}

export interface IgPublishSpec {
  pageId: string
  caption: string
  /** A private-bucket storage path (generated/...) OR a public http image url. */
  mediaRef: string
}

/**
 * Publish a single-image post to the page's linked Instagram account. Two-step:
 * create container → publish. Returns the new media id and (best-effort) its
 * permalink. Surfaces Meta's error verbatim so the owner sees the real reason.
 */
export async function publishInstagramImage(
  spec: IgPublishSpec,
): Promise<{ success: boolean; mediaId?: string; permalink?: string; igUsername?: string; error?: string }> {
  const acct = await getInstagramAccount(spec.pageId)
  if (!acct.success || !acct.account) return { success: false, error: acct.error }
  const { igUserId, username } = acct.account
  const token = pageToken(spec.pageId)
  const caption = spec.caption ?? ''

  let imageUrl: string
  try {
    imageUrl = await toPublicMediaUrl(spec.mediaRef)
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }

  try {
    // 1) Create the media container.
    const containerParams = new URLSearchParams({ image_url: imageUrl, caption, access_token: token })
    const cRes = await resilientFetch(`${GRAPH_BASE}/${igUserId}/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: containerParams.toString(),
      timeoutMs: 45_000,
      retries: 1,
    })
    const cText = await cRes.text()
    if (!cRes.ok) return { success: false, error: `IG container ${cRes.status}: ${cText.slice(0, 240)}` }
    const creationId = (JSON.parse(cText) as { id?: string }).id
    if (!creationId) return { success: false, error: 'IG media container id ফেরত আসেনি।' }

    // 2) Publish the container.
    const pubParams = new URLSearchParams({ creation_id: creationId, access_token: token })
    const pRes = await resilientFetch(`${GRAPH_BASE}/${igUserId}/media_publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: pubParams.toString(),
      timeoutMs: 45_000,
      retries: 1,
    })
    const pText = await pRes.text()
    if (!pRes.ok) return { success: false, error: `IG publish ${pRes.status}: ${pText.slice(0, 240)}` }
    const mediaId = (JSON.parse(pText) as { id?: string }).id
    if (!mediaId) return { success: false, error: 'IG media id ফেরত আসেনি।' }

    // 3) Best-effort permalink (non-fatal if it fails).
    let permalink: string | undefined
    try {
      const lk = await resilientFetch(
        `${GRAPH_BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`,
        { timeoutMs: 15_000, retries: 0 },
      )
      if (lk.ok) permalink = (JSON.parse(await lk.text()) as { permalink?: string }).permalink
    } catch {
      /* permalink is a nicety, not required for success */
    }

    return { success: true, mediaId, permalink, igUsername: username }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
