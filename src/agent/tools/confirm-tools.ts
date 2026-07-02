// Tools that create pending actions (confirm-card flow) rather than executing directly.
import { prisma } from '@/lib/prisma'
import { resolvePageId, getRecentPosts, getMessengerInbox, pageLabel, getUnansweredComments } from '@/agent/lib/meta'
import { resolveFbPostImageRef } from '@/agent/lib/fb-image-resolve'
import { formatDateTimeDhaka } from '@/lib/agent-api/dhaka-date'
import type { AgentTool } from './registry'

// ── Image generation ───────────────────────────────────────────────────────

const generate_image: AgentTool = {
  name: 'generate_image',
  description:
    'Generates an image using Nano Banana (Google Gemini). ' +
    'This tool creates a PENDING ACTION — the owner must approve before the image is generated. ' +
    'quality: "pro" (face-preservation, product mockups, ~৳4.50/image) | "standard" (routine, ~৳1.10/image). ' +
    'referenceImageId: optional Supabase storage path for reference image.',
  input_schema: {
    type: 'object' as const,
    properties: {
      prompt: { type: 'string', description: 'Detailed image generation prompt (English)' },
      quality: {
        type: 'string',
        enum: ['pro', 'standard'],
        description: '"pro" for product/face, "standard" for general',
      },
      referenceImageId: {
        type: 'string',
        description: 'Optional Supabase storage path of reference image',
      },
      aspectRatio: {
        type: 'string',
        enum: ['1:1', '4:5', '16:9', '9:16'],
        description: 'Output aspect ratio (default 4:5 for FB/IG feed)',
      },
      imageSize: {
        type: 'string',
        enum: ['1K', '2K', '4K'],
        description: 'Output resolution (default 2K)',
      },
      conversationId: { type: 'string' },
    },
    required: ['prompt'],
  },
  handler: async (input) => {
    try {
      const quality = (input.quality as string) === 'standard' ? 'standard' : 'pro'
      const costEstimate = quality === 'pro' ? 4.5 : 1.1 // BDT estimate

      const summary =
        `Image generation request (${quality} quality)\n` +
        `Prompt: ${String(input.prompt).slice(0, 200)}`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'image_gen',
          payload: {
            prompt: input.prompt,
            quality,
            referenceImageId: input.referenceImageId ?? null,
            aspectRatio: input.aspectRatio ?? null,
            imageSize: input.imageSize ?? null,
            conversationId: input.conversationId ?? null,
          },
          summary,
          costEstimate,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          costEstimate,
          message:
            'Image generation request created. Awaiting owner approval before rendering.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Facebook posting ───────────────────────────────────────────────────────

const post_to_facebook: AgentTool = {
  name: 'post_to_facebook',
  description:
    'Posts to an Alma Facebook page. ' +
    'This tool ALWAYS creates a PENDING ACTION — the owner must approve before posting. ' +
    'page: "lifestyle" (Alma Lifestyle) | "onlineshop" (Alma Online Shop). ' +
    'imageArtifactOrFileId: photo path — generated/<id>.png from AI OR chat upload path from [Uploaded file path: ...]. Auto-resolved from conversation if omitted.',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: {
        type: 'string',
        enum: ['lifestyle', 'onlineshop'],
        description: 'Facebook page to post to',
      },
      message: { type: 'string', description: 'Post text content' },
      imageArtifactOrFileId: {
        type: 'string',
        description: 'Supabase path: generated/<id>.png or chat upload path — optional if image was uploaded in this chat',
      },
      textOnly: {
        type: 'boolean',
        description: 'True only for caption-only posts with no image',
      },
      conversationId: { type: 'string' },
    },
    required: ['page', 'message'],
  },
  handler: async (input) => {
    try {
      const page = String(input.page)
      const message = String(input.message)
      const pageId = resolvePageId(page)
      const conversationId = input.conversationId ? String(input.conversationId) : null
      const textOnly = input.textOnly === true

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { imageRef, hadRecentPostableImage } = await resolveFbPostImageRef(prisma as any, {
        conversationId,
        imageArtifactOrFileId: input.imageArtifactOrFileId,
        textOnly,
      })

      const imageLine = imageRef
        ? `📷 ছবি: ${imageRef}\n\n`
        : hadRecentPostableImage
          ? `⚠️ ছবি path খুঁজে পাওয়া যায়নি — Approve করলে শুধু ক্যাপশন যাবে!\n\n`
          : textOnly
            ? `📝 শুধু টেক্সট পোস্ট\n\n`
            : ''

      const summary =
        `Facebook post → Alma ${page === 'lifestyle' ? 'Lifestyle' : 'Online Shop'}\n` +
        imageLine +
        `"${message.slice(0, 300)}${message.length > 300 ? '…' : ''}"`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId,
          type: 'fb_post',
          payload: {
            page,
            pageId,
            message,
            imageUrl: imageRef ?? null,
            imageArtifactOrFileId: imageRef ?? null,
            textOnly,
            wantsImage: Boolean(imageRef) || (hadRecentPostableImage && !textOnly),
            conversationId,
          },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          costEstimate: 0,
          message: 'Facebook post staged. Awaiting owner approval before publishing.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Instagram: publish a single-image feed post ────────────────────────────

const publish_to_instagram: AgentTool = {
  name: 'publish_to_instagram',
  description:
    "Publishes a single-image post to ALMA's Instagram — the IG Business account LINKED to the chosen Facebook page. " +
    'This tool ALWAYS creates a PENDING ACTION — the owner must approve before anything goes live (the post is PUBLIC). ' +
    'Instagram REQUIRES an image: there are NO caption-only IG posts. ' +
    'page: "lifestyle" (Alma Lifestyle) | "onlineshop" (Alma Online Shop) picks which linked IG account. ' +
    'imageArtifactOrFileId: photo path — generated/<id>.png from generate_image OR a chat upload path. Auto-resolved from the conversation if omitted. ' +
    'For Facebook use post_to_facebook; this is the Instagram twin. Reels/video are not supported yet (coming via the worker queue).',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: {
        type: 'string',
        enum: ['lifestyle', 'onlineshop'],
        description: "Which page's linked Instagram account to post to",
      },
      caption: { type: 'string', description: 'Instagram caption (Bangla ok, hashtags ok)' },
      imageArtifactOrFileId: {
        type: 'string',
        description: 'Supabase path: generated/<id>.png or chat upload path — optional if an image was generated/uploaded in this chat',
      },
      conversationId: { type: 'string' },
    },
    required: ['page', 'caption'],
  },
  handler: async (input) => {
    try {
      const page = String(input.page)
      const caption = String(input.caption)
      const pageId = resolvePageId(page)
      const conversationId = input.conversationId ? String(input.conversationId) : null

      // Instagram has no caption-only posts — an image is mandatory. Reuse the
      // exact FB image-resolution chain (explicit ref → conversation generated →
      // conversation upload). textOnly is always false here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { imageRef, hadRecentPostableImage } = await resolveFbPostImageRef(prisma as any, {
        conversationId,
        imageArtifactOrFileId: input.imageArtifactOrFileId,
        textOnly: false,
      })

      if (!imageRef) {
        return {
          success: false,
          error: hadRecentPostableImage
            ? 'ছবির path খুঁজে পাওয়া যায়নি — imageArtifactOrFileId দিন (generated/<id>.png)।'
            : 'Instagram পোস্টে ছবি বাধ্যতামূলক — আগে generate_image approve করুন বা একটি ছবি upload করুন, তারপর publish করুন।',
        }
      }

      const igLabel = page === 'lifestyle' ? 'Alma Lifestyle' : 'Alma Online Shop'
      const summary =
        `📸 Instagram পোস্ট → ${igLabel} (linked IG)\n` +
        `ছবি: ${imageRef}\n\n` +
        `"${caption.slice(0, 300)}${caption.length > 300 ? '…' : ''}"\n\n` +
        '✅ Approve করলেই Instagram-এ সরাসরি লাইভ পোস্ট হবে — এটি public, সবাই দেখতে পাবে।'

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId,
          type: 'instagram_post',
          payload: {
            page,
            pageId,
            caption,
            imageUrl: imageRef,
            imageArtifactOrFileId: imageRef,
            conversationId,
          },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          costEstimate: 0,
          message: 'Instagram post staged. Awaiting owner approval before publishing.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Read: recent FB posts (no confirmation needed) ─────────────────────────

const get_fb_recent_posts: AgentTool = {
  name: 'get_fb_recent_posts',
  description:
    'Fetches recent posts from an Alma Facebook page (read-only, no confirmation needed). ' +
    'page: "lifestyle" | "onlineshop". limit: 1–25 (default 10).',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: { type: 'string', enum: ['lifestyle', 'onlineshop'] },
      limit: { type: 'number' },
    },
    required: ['page'],
  },
  handler: async (input) => {
    try {
      const pageId = resolvePageId(String(input.page))
      const posts = await getRecentPosts({ pageId, limit: Number(input.limit ?? 10) })
      return { success: true, data: { posts, page: input.page, pageId } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const get_fb_messenger_inbox: AgentTool = {
  name: 'get_fb_messenger_inbox',
  description:
    'Reads recent Facebook Page Messenger inbox threads (read-only). ' +
    'Use when the owner asks about page DMs, inbox, customer messages, or unanswered chats — NOT for public posts. ' +
    'Each thread includes customerPsid + customerName — to REPLY to a thread, pass that customerPsid straight to send_customer_message (works even if the customer is not in the ERP DB). ' +
    'page: "lifestyle" | "onlineshop". limit: 1–25 conversations (default 15).',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: { type: 'string', enum: ['lifestyle', 'onlineshop'] },
      limit: { type: 'number' },
    },
    required: ['page'],
  },
  handler: async (input) => {
    try {
      const pageId = resolvePageId(String(input.page))
      const limit = Number(input.limit ?? 15)
      const threads = await getMessengerInbox({ pageId, limit })
      const openAlerts = await prisma.agentMessengerAlert.findMany({
        where: { pageId, resolved: false },
        orderBy: { detectedAt: 'desc' },
        take: 20,
        select: {
          conversationId: true,
          alertType: true,
          detectedAt: true,
        },
      })

      const needsReply = threads.filter(t => t.needsReply)
      const recentCustomer = threads.filter(t => t.lastMessage?.from === 'customer')
      const scannedNow = new Date()

      // Owner rule: "1 pending message" is useless — the agent must SEE the
      // actual content. Image attachments on awaiting-reply customer messages
      // get a Bangla vision description (max 3 per scan; fail-open per image).
      const withImages = needsReply
        .filter(t => (t.lastMessage?.attachmentImageUrls?.length ?? 0) > 0)
        .slice(0, 3)
      const imageDescriptions: Record<string, string> = {}
      for (const t of withImages) {
        const url = t.lastMessage?.attachmentImageUrls?.[0]
        if (!url) continue
        try {
          const imgRes = await fetch(url, { signal: AbortSignal.timeout(15_000) })
          if (!imgRes.ok) continue
          const mime = imgRes.headers.get('content-type')?.split(';')[0] || 'image/jpeg'
          const buf = Buffer.from(await imgRes.arrayBuffer())
          if (buf.length > 8_000_000) continue
          const { geminiVisionJson } = await import('@/agent/lib/vision-analyze')
          const out = await geminiVisionJson<{ description?: string }>({
            prompt:
              'This is an image a customer sent to a Bangladeshi clothing shop\'s Facebook page. ' +
              'Describe in 1-2 Bangla sentences what it shows (product/panjabi/screenshot/payment slip/etc), so a sales agent can reply. ' +
              'Return JSON: {"description": "..."}',
            imageBase64: buf.toString('base64'),
            mimeType: mime,
            costKind: 'cs_inbox_image',
            maxTokens: 200,
          })
          if (out.description) imageDescriptions[t.conversationId] = out.description
        } catch { /* skip this image */ }
      }
      const threadsOut = threads.map(t =>
        imageDescriptions[t.conversationId]
          ? { ...t, lastMessage: { ...t.lastMessage!, imageDescription: imageDescriptions[t.conversationId] } }
          : t,
      )

      return {
        success: true,
        data: {
          page: input.page,
          pageId,
          pageName: pageLabel(pageId),
          scannedAtUtc: scannedNow.toISOString(),
          scannedAtDhaka: formatDateTimeDhaka(scannedNow),
          timezone: 'Asia/Dhaka (UTC+6)',
          summary: {
            threadsScanned: threads.length,
            awaitingReply30minPlus: needsReply.length,
            lastFromCustomer: recentCustomer.length,
            openWorkerAlerts: openAlerts.length,
          },
          threads: threadsOut,
          openAlerts: openAlerts.map(a => ({
            ...a,
            detectedAtDhaka: formatDateTimeDhaka(a.detectedAt),
          })),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Send customer message (Messenger DM) ─────────────────────────────────

const send_customer_message: AgentTool = {
  name: 'send_customer_message',
  description:
    'Sends a message to a customer via Facebook Messenger (page DM, not wall post). ' +
    'Creates a PENDING ACTION — owner must approve before sending. ' +
    'Resolves customer by name (from cs_customers) or by raw PSID. ' +
    'page: "lifestyle" | "onlineshop". Respects Meta 24-hour messaging window.',
  input_schema: {
    type: 'object' as const,
    properties: {
      customerNameOrPsid: {
        type: 'string',
        description: 'Customer name (looked up in cs_customers) or raw Facebook PSID',
      },
      page: {
        type: 'string',
        enum: ['lifestyle', 'onlineshop'],
        description: 'Facebook page to send from',
      },
      message: {
        type: 'string',
        description: 'Message text to send (max 2000 chars)',
      },
      conversationId: { type: 'string' },
    },
    required: ['customerNameOrPsid', 'page', 'message'],
  },
  handler: async (input) => {
    try {
      const customerInput = String(input.customerNameOrPsid).trim()
      const page = String(input.page)
      const message = String(input.message).slice(0, 2000)
      const pageId = resolvePageId(page)
      const pageName = pageLabel(pageId)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any

      let psid: string | null = null
      let customerName: string | null = null

      const isRawPsid = /^\d{10,}$/.test(customerInput)
      if (isRawPsid) {
        psid = customerInput
        const cust = await db.csCustomer.findFirst({
          where: { psid: customerInput, pageId },
          select: { name: true },
        })
        customerName = cust?.name ?? customerInput
      } else {
        const cust = await db.csCustomer.findFirst({
          where: {
            name: { contains: customerInput, mode: 'insensitive' },
            pageId,
          },
          select: { psid: true, name: true },
        })
        if (!cust) {
          return {
            success: false,
            error: `"${customerInput}" নামে কোনো কাস্টমার ${pageName}-এ পাওয়া যায়নি। সঠিক নাম বা PSID দিন।`,
          }
        }
        psid = cust.psid
        customerName = cust.name
      }

      const conv = await db.csConversation.findFirst({
        where: { pageId, psid },
        select: { lastCustomerMessageAt: true },
      })
      if (conv?.lastCustomerMessageAt) {
        const ageMs = Date.now() - new Date(conv.lastCustomerMessageAt).getTime()
        if (ageMs > 23.5 * 60 * 60 * 1000) {
          return {
            success: false,
            error: `24-ঘণ্টা পার হয়ে গেছে — Meta নিয়ম অনুযায়ী কাস্টমারকে message পাঠানো যাবে না। কাস্টমার আবার message করলে window নতুন করে শুরু হবে।`,
          }
        }
      }

      const summary =
        `📩 কাস্টমার মেসেজ → ${customerName} (${pageName})\n\n` +
        `"${message.slice(0, 300)}${message.length > 300 ? '…' : ''}"`

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'send_customer_message',
          payload: { pageId, psid, page, message, customerName },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          costEstimate: 0,
          message: `মেসেজ ${customerName}-কে পাঠানোর জন্য তৈরি। মালিকের Approve প্রয়োজন।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

// ── Public comment reply (Facebook wall comments, not Messenger) ─────────────

const get_unanswered_comments: AgentTool = {
  name: 'get_unanswered_comments',
  description:
    'Reads PUBLIC customer comments on recent Facebook page posts that the page has NOT yet replied to ' +
    '(read-only, no confirmation). Use when the owner asks about unanswered comments, "কমেন্টের রিপ্লাই বাকি", ' +
    'or before drafting comment replies. Returns each comment\'s id, author name, text and post permalink. ' +
    'page: "lifestyle" | "onlineshop". postLimit: 1–25 recent posts to scan (default 12). ' +
    'To actually reply, pass a returned commentId to reply_to_comment.',
  input_schema: {
    type: 'object' as const,
    properties: {
      page: { type: 'string', enum: ['lifestyle', 'onlineshop'] },
      postLimit: { type: 'number' },
    },
    required: ['page'],
  },
  handler: async (input) => {
    try {
      const pageId = resolvePageId(String(input.page))
      const comments = await getUnansweredComments({
        pageId,
        postLimit: Number(input.postLimit ?? 12),
      })
      const scannedNow = new Date()
      return {
        success: true,
        data: {
          page: input.page,
          pageId,
          pageName: pageLabel(pageId),
          scannedAtDhaka: formatDateTimeDhaka(scannedNow),
          timezone: 'Asia/Dhaka (UTC+6)',
          unansweredCount: comments.length,
          comments,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

const reply_to_comment: AgentTool = {
  name: 'reply_to_comment',
  description:
    'Publishes a PUBLIC reply to a customer comment on a Facebook page post. ' +
    'Creates a PENDING ACTION — owner must approve before the reply is posted publicly. ' +
    'Get the commentId from get_unanswered_comments first. ' +
    'page: "lifestyle" | "onlineshop". Keep the reply short, warm Bangla, address the customer politely. ' +
    'For price/order questions, give the real answer (verify stock/price first); never invent details. ' +
    'Do NOT post a public reply for anything private — use send_customer_message (Messenger DM) instead.',
  input_schema: {
    type: 'object' as const,
    properties: {
      commentId: { type: 'string', description: 'Facebook comment id from get_unanswered_comments' },
      page: { type: 'string', enum: ['lifestyle', 'onlineshop'], description: 'Facebook page the comment is on' },
      message: { type: 'string', description: 'Reply text to post publicly (max 1000 chars)' },
      customerName: { type: 'string', description: 'Comment author name (for the approval card summary)' },
      commentText: { type: 'string', description: 'The original comment text (for the approval card summary)' },
      conversationId: { type: 'string' },
    },
    required: ['commentId', 'page', 'message'],
  },
  handler: async (input) => {
    try {
      const commentId = String(input.commentId).trim()
      const page = String(input.page)
      const message = String(input.message).slice(0, 1000)
      const pageId = resolvePageId(page)
      const pageName = pageLabel(pageId)

      if (!commentId) {
        return { success: false, error: 'commentId দরকার — আগে get_unanswered_comments দিয়ে কমেন্ট আনুন।' }
      }
      if (!message.trim()) {
        return { success: false, error: 'রিপ্লাই টেক্সট খালি।' }
      }

      const who = input.customerName ? String(input.customerName) : 'কাস্টমার'
      const original = input.commentText ? String(input.commentText).slice(0, 200) : null
      const summary =
        `💬 কমেন্ট রিপ্লাই → ${who} (${pageName})\n` +
        (original ? `\nকমেন্ট: "${original}${String(input.commentText).length > 200 ? '…' : ''}"\n` : '') +
        `\nরিপ্লাই: "${message.slice(0, 300)}${message.length > 300 ? '…' : ''}"\n\n` +
        `⚠️ Approve করলে রিপ্লাই পাবলিকভাবে পোস্ট হবে।`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const db = prisma as any
      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'reply_to_comment',
          payload: { pageId, page, commentId, message, customerName: input.customerName ?? null },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          costEstimate: 0,
          message: `${who}-এর কমেন্টে রিপ্লাই তৈরি। মালিকের Approve করলে পাবলিকভাবে পোস্ট হবে।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const CONFIRM_TOOLS: AgentTool[] = [
  generate_image,
  post_to_facebook,
  publish_to_instagram,
  send_customer_message,
  get_fb_recent_posts,
  get_fb_messenger_inbox,
  get_unanswered_comments,
  reply_to_comment,
]
