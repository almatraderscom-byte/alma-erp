import { prisma as db } from '@/lib/prisma'
import { listGbpReviews } from '@/agent/lib/gbp'
import type { AgentTool } from './registry'

/**
 * Google Business Profile tools (Growth Feature 7). Reading reviews is free and
 * direct; replying to a review or publishing a local post is PUBLIC-facing, so
 * both only DRAFT an approval card here — the send happens in the approve route
 * (types 'gbp_reply' / 'gbp_post') after the owner taps Approve.
 */

const get_gbp_reviews: AgentTool = {
  name: 'get_gbp_reviews',
  description:
    'REAL Google Business Profile reviews for the shop (FREE read) — reviewer, star rating, comment, date, ' +
    'and whether the owner already replied, plus the average rating. Use when the owner asks about Google ' +
    'reviews, রিভিউ, rating, or local reputation. Requires the owner to have connected Google (Growth page) ' +
    'with Business Profile permission and the GBP APIs enabled in GCP.',
  input_schema: {
    type: 'object' as const,
    properties: {
      limit: { type: 'number', description: 'Max reviews to return (default 10, max 50).' },
    },
  },
  handler: async (input) => {
    const r = await listGbpReviews(Number(input.limit ?? 10))
    if (!r.ok) return { success: false, error: r.error }
    return { success: true, data: r.data }
  },
}

const draft_gbp_reply: AgentTool = {
  name: 'draft_gbp_reply',
  description:
    'Draft the owner\'s PUBLIC reply to a Google review and stage ONE approval card — nothing posts until ' +
    'the owner approves. Get the exact reviewId from get_gbp_reviews first. Reply should be warm Bangla ' +
    '(English okay if the review is English), on-brand, halal-compliant, thanking the customer; for negative ' +
    'reviews apologise and offer to fix. Public-facing → strictly approval-gated.',
  input_schema: {
    type: 'object' as const,
    properties: {
      reviewId: { type: 'string', description: 'Exact reviewId from get_gbp_reviews.' },
      reviewSnippet: { type: 'string', description: 'Short quote of the review (for the approval card).' },
      reply: { type: 'string', description: 'The public reply text.' },
      conversationId: { type: 'string', description: 'Current conversation id (approval card shows in this chat).' },
    },
    required: ['reviewId', 'reply'],
  },
  handler: async (input) => {
    try {
      const reviewId = String(input.reviewId ?? '').trim()
      const reply = String(input.reply ?? '').trim()
      if (!reviewId || !reply) return { success: false, error: 'reviewId এবং reply দুটোই দিন।' }
      const snippet = input.reviewSnippet ? String(input.reviewSnippet).slice(0, 120) : ''
      const summary =
        `⭐ Google রিভিউর জবাব (public)\n` +
        (snippet ? `রিভিউ: “${snippet}”\n` : '') +
        `জবাব: “${reply.slice(0, 250)}${reply.length > 250 ? '…' : ''}”\n\n` +
        `Approve করলে জবাবটা Google-এ সবার কাছে দৃশ্যমান হবে।`
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'gbp_reply',
          payload: { reviewId, reply, reviewSnippet: snippet },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: { pendingActionId: action.id, message: 'জবাবের খসড়া রেডি — owner Approve করলে Google-এ পোস্ট হবে।' },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const draft_gbp_post: AgentTool = {
  name: 'draft_gbp_post',
  description:
    'Draft a PUBLIC Google Business Profile update post ("What\'s New" — e.g. new collection, offer, Eid ' +
    'timing) and stage ONE approval card — nothing publishes until the owner approves. Bangla, on-brand, ' +
    'halal-compliant; optional link (e.g. https://www.almatraders.com). Public-facing → strictly approval-gated.',
  input_schema: {
    type: 'object' as const,
    properties: {
      summary: { type: 'string', description: 'The post text (Bangla, max ~1500 chars).' },
      ctaUrl: { type: 'string', description: 'Optional Learn-More link, e.g. https://www.almatraders.com.' },
      conversationId: { type: 'string', description: 'Current conversation id (approval card shows in this chat).' },
    },
    required: ['summary'],
  },
  handler: async (input) => {
    try {
      const text = String(input.summary ?? '').trim()
      if (!text) return { success: false, error: 'post-এর summary দিন।' }
      const ctaUrl = input.ctaUrl ? String(input.ctaUrl).trim() : ''
      if (ctaUrl && !/^https:\/\/(www\.)?almatraders\.com(\/|$)/.test(ctaUrl)) {
        return { success: false, error: 'ctaUrl শুধু almatraders.com-এর লিংক হতে পারে।' }
      }
      const summary =
        `📍 Google Business Profile পোস্ট (public)\n` +
        `“${text.slice(0, 250)}${text.length > 250 ? '…' : ''}”` +
        (ctaUrl ? `\nলিংক: ${ctaUrl}` : '') +
        `\n\nApprove করলে পোস্টটা Google Maps/Search-এ সবার কাছে দৃশ্যমান হবে।`
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'gbp_post',
          payload: { summary: text, ctaUrl },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })
      return {
        success: true,
        data: { pendingActionId: action.id, message: 'পোস্টের খসড়া রেডি — owner Approve করলে Google-এ পাবলিশ হবে।' },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const GBP_TOOLS: AgentTool[] = [get_gbp_reviews, draft_gbp_reply, draft_gbp_post]

export const GBP_ROLE_PROMPT = `
## Google Business Profile (লোকাল)
Google রিভিউ দেখতে **get_gbp_reviews** (ফ্রি read) — rating, মন্তব্য, জবাব হয়েছে কিনা। রিভিউর জবাব দিতে **draft_gbp_reply** (exact reviewId লাগবে), আর দোকানের আপডেট/অফার Google Maps-এ পোস্ট করতে **draft_gbp_post** — দুটোই public-facing, তাই **শুধু খসড়া হয়; owner Approve করলে তবেই Google-এ যায়**। জবাব আন্তরিক বাংলায় (রিভিউ English হলে English), নেতিবাচক রিভিউতে দুঃখপ্রকাশ + সমাধানের প্রস্তাব।
`
