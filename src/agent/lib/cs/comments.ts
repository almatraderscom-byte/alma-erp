import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL } from '@/agent/config'
import { prisma } from '@/lib/prisma'
import { csReplyPermitted } from '@/agent/lib/cs/modes'
import { findOrCreateCsConversation, appendCsMessage } from '@/agent/lib/cs/conversations'
import {
  pageAccessToken,
  sendPrivateReplyToComment,
  sendPublicReplyToComment,
  fetchPostImageUrl,
} from '@/agent/lib/cs/meta-messenger'
import { getPostProductCodes, suggestPostProductsFromImage } from '@/agent/lib/cs/post-products'
import { normalizeProductCode } from '@/agent/lib/catalog/inventory-lookup'
import { roundMoney } from '@/lib/money'
import { recordCsEvent } from '@/agent/lib/cs/analytics'
import { logCost } from '@/agent/lib/cost-events'
import { searchVisualIndexFromImage } from '@/agent/lib/cs/product-index'
import { resolveProductCode } from '@/agent/lib/catalog/inventory-lookup'
import { notifyOwner } from '@/agent/lib/notify-owner'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export type FeedComment = {
  commentId: string
  postId: string
  pageId: string
  psid: string
  message: string
  fromName?: string
}

export async function isPublicCommentReplyEnabled(): Promise<boolean> {
  const row = await db.agentKvSetting.findUnique({ where: { key: 'cs_public_comment_reply' } })
  return String(row?.value ?? 'false') === 'true'
}

export async function classifyBuyingIntent(message: string): Promise<boolean> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const res = await client.messages.create({
    model: AGENT_MODEL,
    max_tokens: 64,
    messages: [{
      role: 'user',
      content: `Facebook comment on a clothing shop post. Does this show buying intent (price, size, order, inbox, details)? Reply ONLY yes or no.\n\nComment: ${message.slice(0, 500)}`,
    }],
  })
  const text = res.content.filter((b) => b.type === 'text').map((b) => (b.type === 'text' ? b.text : '')).join('').toLowerCase()
  void logCost({
    provider: 'anthropic',
    kind: 'cs_comment_classify',
    units: { tokens_in: res.usage.input_tokens, tokens_out: res.usage.output_tokens, model: AGENT_MODEL },
    costUsd: 0,
    dedupKey: `cs_comment_classify:${Date.now()}`,
  })
  return text.includes('yes')
}

async function buildCommentPrivateReply(input: {
  pageId: string
  postId: string
  commentText: string
}): Promise<string> {
  let codes = await getPostProductCodes(input.postId, input.pageId)

  if (!codes.length) {
    const imageUrl = await fetchPostImageUrl(input.pageId, input.postId)
    if (imageUrl) {
      try {
        const res = await fetch(imageUrl)
        if (res.ok) {
          const b64 = Buffer.from(await res.arrayBuffer()).toString('base64')
          const mime = res.headers.get('content-type') ?? 'image/jpeg'
          const hits = await searchVisualIndexFromImage(b64, mime, 1)
          if (hits[0]) codes = [hits[0].productCode]
        }
      } catch { /* */ }
    }
  }

  if (codes.length) {
    const code = normalizeProductCode(codes[0])
    const resolved = await resolveProductCode(code)
    const price = resolved.ok
      ? `দাম ${roundMoney(resolved.row.sellPrice).toLocaleString('bn-BD')}৳`
      : 'দাম জানতে চাইছেন'
    const label = resolved.ok ? resolved.row.name : 'এই পাঞ্জাবিটার'
    return `আসসালামু আলাইকুম ভাইয়া 😊 ${label} ${price} — size কোনটা লাগবে?`
  }

  return 'আসসালামু আলাইকুম ভাইয়া 😊 ইনবক্সে সাইজ ও ঠিকানা লিখুন, সাহায্য করছি।'
}

export async function handleFeedComment(comment: FeedComment): Promise<{ handled: boolean; reason?: string }> {
  if (!pageAccessToken(comment.pageId)) return { handled: false, reason: 'no_token' }

  const existingComment = await db.csCommentReply.findUnique({
    where: { commentId: comment.commentId },
  })
  if (existingComment) return { handled: false, reason: 'already_replied' }

  const existingUserPost = await db.csCommentReply.findFirst({
    where: { postId: comment.postId, psid: comment.psid },
  })
  if (existingUserPost) return { handled: false, reason: 'user_post_dedupe' }

  const isBuying = await classifyBuyingIntent(comment.message)
  if (!isBuying) return { handled: false, reason: 'not_buying_intent' }

  const conv = await findOrCreateCsConversation({
    pageId: comment.pageId,
    psid: comment.psid,
    customerName: comment.fromName,
  })

  const { permitted, effectiveMode } = await csReplyPermitted(conv)
  if (!permitted) return { handled: false, reason: 'cs_off' }

  const replyText = await buildCommentPrivateReply({
    pageId: comment.pageId,
    postId: comment.postId,
    commentText: comment.message,
  })

  await appendCsMessage(conv.id, 'system', [{
    type: 'text',
    text: `[FB comment on post ${comment.postId}]: ${comment.message}`,
  }])

  if (effectiveMode === 'shadow') {
    const draft = await db.csShadowDraft.create({
      data: {
        conversationId: conv.id,
        pageId: comment.pageId,
        psid: comment.psid,
        draftText: replyText,
        attachments: [],
        status: 'pending',
      },
    })
    await notifyOwner({
      tier: 1,
      title: '💬 CS Comment Draft',
      message: `Comment: ${comment.message.slice(0, 80)}\nDraft: ${replyText}\nShadow ID: ${draft.id}`,
      category: 'task',
    })
    await db.csCommentReply.create({
      data: {
        commentId: comment.commentId,
        postId: comment.postId,
        pageId: comment.pageId,
        psid: comment.psid,
      },
    })
    await recordCsEvent('comment_capture', {
      conversationId: conv.id,
      metadata: { commentId: comment.commentId, shadow: true },
    })
    return { handled: true, reason: 'shadow_draft' }
  }

  await sendPrivateReplyToComment(comment.pageId, comment.commentId, replyText)
  await appendCsMessage(conv.id, 'assistant', [{ type: 'text', text: replyText }])

  if (await isPublicCommentReplyEnabled()) {
    await sendPublicReplyToComment(comment.pageId, comment.commentId, 'ইনবক্স চেক করুন ভাইয়া 🙏')
  }

  await db.csCommentReply.create({
    data: {
      commentId: comment.commentId,
      postId: comment.postId,
      pageId: comment.pageId,
      psid: comment.psid,
      publicReplied: await isPublicCommentReplyEnabled(),
    },
  })

  await recordCsEvent('comment_capture', {
    conversationId: conv.id,
    metadata: { commentId: comment.commentId },
  })

  return { handled: true }
}

export async function handleFeedPostAdded(input: {
  postId: string
  pageId: string
}): Promise<void> {
  const imageUrl = await fetchPostImageUrl(input.pageId, input.postId)
  if (imageUrl) {
    await suggestPostProductsFromImage({
      postId: input.postId,
      pageId: input.pageId,
      imageUrl,
    })
  }
}
