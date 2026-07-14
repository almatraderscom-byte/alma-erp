import { prisma } from '@/lib/prisma'
import { loadProductAsset } from '@/lib/content-engine/pipeline'
import {
  buildVideoBrief,
  estimateReelCostBdt,
  estimateReelCostUsd,
  type VideoAspect,
  type VideoVibe,
} from '@/lib/content-engine/video-brief'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const make_product_reel: AgentTool = {
  name: 'make_product_reel',
  description:
    'Generate a short product Reel/Story video (Veo 3.1 image-to-video) from a product or ad-creative image. ' +
    'Hero use only — owner must approve BEFORE generation (costly ~$0.15/sec). ' +
    'Default 9:16, 6 seconds. On completion → video approval card (nothing auto-posts). ' +
    'No auto-scheduler — call only when owner explicitly wants a reel.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productCode: { type: 'string', description: 'Product in content library (preferred)' },
      imagePath: { type: 'string', description: 'agent-files path — ad creative or product photo' },
      aspect: { type: 'string', enum: ['9:16', '16:9'], description: 'Default 9:16 (Reels/Story)' },
      durationSec: { type: 'number', description: '4–8 seconds, default 6' },
      vibe: { type: 'string', enum: ['premium', 'festival', 'offer', 'lifestyle'], description: 'Overall mood of the reel' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
  },
  handler: async (input) => {
    try {
      const productCode = input.productCode ? String(input.productCode).trim() : undefined
      let imagePath = input.imagePath ? String(input.imagePath).trim() : undefined
      let product = productCode ? await loadProductAsset(productCode) : null

      if (product && !imagePath) {
        imagePath = product.imagePath
      }
      if (!imagePath && productCode) {
        product = await loadProductAsset(productCode)
        imagePath = product?.imagePath
      }
      if (!imagePath) {
        return {
          success: false,
          error: 'productCode বা imagePath লাগবে — content library-তে product যোগ করুন বা ad creative path দিন।',
        }
      }

      if (!product && productCode) {
        product = await loadProductAsset(productCode)
      }
      const asset = product ?? {
        productCode: productCode ?? 'reel',
        name: null,
        category: null,
        fabric: null,
        imagePath,
        familyMatch: false,
      }

      const vibe = (input.vibe as VideoVibe) ?? 'premium'
      const aspect = (input.aspect === '16:9' ? '16:9' : '9:16') as VideoAspect
      const durationSec = Math.min(Math.max(Number(input.durationSec ?? 6), 4), 8)
      const { prompt } = buildVideoBrief(asset, { vibe, aspect, durationSec })

      const costUsd = estimateReelCostUsd(durationSec)
      const costBdt = estimateReelCostBdt(durationSec)

      const summary =
        `Product Reel (Veo 3.1) — owner approval required\n` +
        `Product: ${asset.productCode}\n` +
        `Aspect: ${aspect} | Duration: ${durationSec}s\n` +
        `Estimated cost: ~$${costUsd.toFixed(2)} (≈৳${costBdt})\n\n` +
        `Reference: ${imagePath}\n\n` +
        'Approve করলে VPS worker Veo generation শুরু করবে — শেষে reel approval card আসবে। Auto-post হবে না।'

      const action = await db.agentPendingAction.create({
        data: {
          conversationId: input.conversationId ? String(input.conversationId) : null,
          type: 'video_gen',
          payload: {
            prompt,
            referenceImageId: imagePath,
            durationSec,
            aspect,
            conversationId: input.conversationId ?? null,
            productCode: asset.productCode,
            vibe,
          },
          summary,
          costEstimate: costBdt,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          summary,
          actionType: 'video_gen',
          costEstimate: costBdt,
          costUsd,
          message: 'Reel generation queued for owner approval — no auto-scheduler.',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const VIDEO_TOOLS: AgentTool[] = [make_product_reel]

export const VIDEO_ROLE_PROMPT = `
## VIDEO REELS (Veo 3.1 — hero only)
make_product_reel: image-to-video Reels/Stories from product or ad-creative image. Owner must approve BEFORE generation (~$0.15/sec). On completion → video_reel_gate approval card — nothing auto-posts. NO auto-scheduler; owner-trigger only. For bulk placement video use Meta Advantage+ static→video (free).
`
