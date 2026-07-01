// Growth Autopilot — scheduled-post publisher.
//
// Publishes ONE approved calendar entry to Facebook or Instagram, verifies the
// result, and returns a normalized outcome. Used by the growth-publish cron.
// Reuses the same Meta helpers as the interactive fb_post / instagram_post
// approval flow so behaviour is identical — the only difference is *when* it
// runs (at the scheduled time, not the moment of approval).
import { createPagePost, verifyPost, resolvePageId } from '@/agent/lib/meta'

export interface CalendarEntryLike {
  id: string
  platform: string
  pageRef: string
  caption: string
  imageRef: string | null
}

export interface PublishOutcome {
  ok: boolean
  postId?: string
  permalinkUrl?: string
  error?: string
}

/**
 * Publish a single calendar entry. Never throws — always resolves to a
 * PublishOutcome so the cron can record success/failure per row.
 */
export async function publishCalendarEntry(entry: CalendarEntryLike): Promise<PublishOutcome> {
  try {
    const pageId = resolvePageId(entry.pageRef || 'lifestyle')
    const platform = (entry.platform || 'facebook').toLowerCase()

    if (platform === 'instagram') {
      if (!entry.imageRef) {
        return { ok: false, error: 'Instagram পোস্টের জন্য ছবি লাগবে — imageRef খালি।' }
      }
      const { publishInstagramImage } = await import('@/agent/lib/meta-instagram')
      const res = await publishInstagramImage({
        pageId,
        caption: entry.caption,
        mediaRef: entry.imageRef,
      })
      if (!res.success) return { ok: false, error: res.error ?? 'IG publish failed' }
      return { ok: true, postId: res.mediaId, permalinkUrl: res.permalink }
    }

    // default: facebook
    const { postId, postedAsPhoto } = await createPagePost({
      pageId,
      message: entry.caption,
      imageUrl: entry.imageRef ?? undefined,
      requireImage: Boolean(entry.imageRef),
    })
    const verified = await verifyPost(pageId, postId)
    if (entry.imageRef && verified.ok && !verified.hasMedia) {
      return { ok: false, error: `Facebook-এ পোস্ট হয়েছে (ID ${postId}) কিন্তু ছবি attach হয়নি।` }
    }
    void postedAsPhoto
    return { ok: true, postId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
