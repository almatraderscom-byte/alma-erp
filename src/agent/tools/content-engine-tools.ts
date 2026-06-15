import { prisma } from '@/lib/prisma'
import { startContentPipeline, loadProductAsset } from '@/lib/content-engine/pipeline'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const add_product_asset: AgentTool = {
  name: 'add_product_asset',
  description:
    'Add a product to the content library (flat product photo + code + fabric details). ' +
    'The autonomous content engine picks from this library for Facebook posts. ' +
    'imagePath must be an agent-files storage path from an owner upload.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productCode: { type: 'string', description: 'SKU / product code, e.g. FM-1234' },
      imagePath: { type: 'string', description: 'agent-files path of flat product photo' },
      name: { type: 'string' },
      category: { type: 'string', description: 'panjabi / family_set / saree / ...' },
      fabric: { type: 'string', description: 'Fabric + design details (Bangla or English)' },
      familyMatch: { type: 'boolean', description: 'True if this has a family-matching set' },
    },
    required: ['productCode', 'imagePath'],
  },
  handler: async (input) => {
    const productCode = String(input.productCode ?? '').trim()
    const imagePath = String(input.imagePath ?? '').trim()
    if (!productCode || !imagePath) {
      return { success: false, error: 'productCode ও imagePath লাগবে।' }
    }
    const existing = await db.productContentAsset.findFirst({ where: { productCode } })
    if (existing) {
      const updated = await db.productContentAsset.update({
        where: { id: existing.id },
        data: {
          imagePath,
          name: input.name ? String(input.name) : existing.name,
          category: input.category ? String(input.category) : existing.category,
          fabric: input.fabric ? String(input.fabric) : existing.fabric,
          familyMatch: input.familyMatch === true,
        },
      })
      return { success: true, data: { updated: true, product: updated } }
    }
    const created = await db.productContentAsset.create({
      data: {
        productCode,
        imagePath,
        name: input.name ? String(input.name) : null,
        category: input.category ? String(input.category) : null,
        fabric: input.fabric ? String(input.fabric) : null,
        familyMatch: input.familyMatch === true,
      },
    })
    return { success: true, data: { created: true, product: created } }
  },
}

const list_product_assets: AgentTool = {
  name: 'list_product_assets',
  description: 'List products in the content library (for FB post engine).',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    const rows = await db.productContentAsset.findMany({
      orderBy: [{ lastPostedAt: 'asc' }, { createdAt: 'asc' }],
      take: 30,
    })
    return { success: true, data: { products: rows } }
  },
}

const run_content_post: AgentTool = {
  name: 'run_content_post',
  description:
    'Start the content engine for a Facebook post (Phase 1: single + father+son variants). ' +
    'Renders DRAFT try-on images with brand frame → Gate 1 approval (images). ' +
    'After Gate 1 approve → PRO re-render + Bangla caption → Gate 2 approval → publish. ' +
    'NEVER publishes without both owner approvals. Omit productCode to auto-pick least-recently-posted.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productCode: { type: 'string', description: 'Optional — omit to auto-pick next product' },
      page: { type: 'string', enum: ['lifestyle', 'onlineshop'], description: 'Default lifestyle' },
      conversationId: { type: 'string' },
    },
  },
  handler: async (input) => {
    try {
      const product = await loadProductAsset(input.productCode ? String(input.productCode) : undefined)
      if (!product) {
        return {
          success: false,
          error: 'কোনো প্রোডাক্ট অ্যাসেট নেই। আগে add_product_asset দিয়ে প্রোডাক্ট যোগ করুন।',
        }
      }
      const result = await startContentPipeline({
        productCode: product.productCode,
        conversationId: input.conversationId ? String(input.conversationId) : null,
        page: input.page === 'onlineshop' ? 'onlineshop' : 'lifestyle',
      })
      return {
        success: true,
        data: {
          ...result,
          message:
            `কন্টেন্ট পাইপলাইন শুরু — ${product.productCode}। ` +
            `Draft রেন্ডার হচ্ছে; Gate 1 কার্ড আসবে ছবি অনুমোদনের জন্য।`,
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const CONTENT_ENGINE_TOOLS: AgentTool[] = [
  add_product_asset,
  list_product_assets,
  run_content_post,
]

export const CONTENT_ENGINE_ROLE_PROMPT = `
## CONTENT & DESIGN ENGINE (Facebook — diagnose-only publish gates)
আপনি দৈনিক Facebook পোস্টের জন্য on-brand family-matching মডেল ফটো + বাংলা ক্যাপশন প্রস্তুত করেন — owner-কে ডিজাইন করতে হয় না।
- প্রোডাক্ট লাইব্রেরি: add_product_asset / list_product_assets
- পোস্ট চালু: run_content_post (Phase 1: single + বাবা+ছেলে, draft→pro)
- সবসময় দুই অনুমোদন: (1) Gate 1 ছবি/ফ্যাব্রিক ঠিক?, (2) Gate 2 ফাইনাল পোস্ট — দুটো ছাড়া publish নয়
- ফেস্টিভাল/শুক্রবার → থিম + হুক স্বয়ংক্রিয়; ব্র্যান্ড ফ্রেম (লোগো/কোড/হুক) কোড দিয়ে — AI টেক্সট রেন্ডার করে না
- owner ফ্যাব্রিক/লুক ঠিক না বললে → আবার run_content_post (নতুন draft)
- কোড লিখবেন/commit/deploy করবেন না — শুধু কন্টেন্ট প্রস্তুত + অনুমোদন কার্ড
`
