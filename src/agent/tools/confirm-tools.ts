// Tools that create pending actions (confirm-card flow) rather than executing directly.
import { prisma } from '@/lib/prisma'
import { resolvePageId, getRecentPosts } from '@/agent/lib/meta'
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
    'imageArtifactOrFileId: optional Supabase storage path or URL of an image to attach.',
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
        description: 'Optional image URL or Supabase storage path',
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

      const summary =
        `Facebook post → Alma ${page === 'lifestyle' ? 'Lifestyle' : 'Online Shop'}\n\n` +
        `"${message.slice(0, 300)}${message.length > 300 ? '…' : ''}"`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'fb_post',
          payload: {
            page,
            pageId,
            message,
            imageUrl: input.imageArtifactOrFileId ?? null,
            conversationId: input.conversationId ?? null,
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

export const CONFIRM_TOOLS: AgentTool[] = [generate_image, post_to_facebook, get_fb_recent_posts]
