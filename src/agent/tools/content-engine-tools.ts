import { prisma } from '@/lib/prisma'
import { startContentPipeline, loadProductAsset } from '@/lib/content-engine/pipeline'
import type { ContentVariant } from '@/lib/content-engine/generate-variants'
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
    'Start the content engine for a Facebook post. Family variants: single, father+son, mother+son, full family. ' +
    'Default: single+father_son; familyMatch products → all 4. Pass variants[] to control cost. ' +
    'DRAFT renders → Gate 1 (per-variant keep/regenerate) → PRO for kept only → Gate 2 → publish. ' +
    'NEVER publishes without both owner approvals.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productCode: { type: 'string', description: 'Optional — omit to auto-pick next product' },
      page: { type: 'string', enum: ['lifestyle', 'onlineshop'], description: 'Default lifestyle' },
      conversationId: { type: 'string' },
      variants: {
        type: 'array',
        items: {
          type: 'string',
          enum: ['single', 'father_son', 'mother_son', 'full_family'],
        },
        description:
          'Which variants to generate. Examples: ["single","father_son"] safe; full set all 4. Cost ≈ draft+pro per variant.',
      },
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
      const variants = Array.isArray(input.variants)
        ? (input.variants as ContentVariant[]).filter((v) =>
            ['single', 'father_son', 'mother_son', 'full_family'].includes(v),
          )
        : undefined
      const result = await startContentPipeline({
        productCode: product.productCode,
        conversationId: input.conversationId ? String(input.conversationId) : null,
        page: input.page === 'onlineshop' ? 'onlineshop' : 'lifestyle',
        variants: variants?.length ? variants : undefined,
      })
      return {
        success: true,
        data: {
          ...result,
          variantLabels: result.variants.map((v) => v),
          message:
            `কন্টেন্ট পাইপলাইন শুরু — ${product.productCode} (${result.variants.length}টি ভ্যারিয়েন্ট)। ` +
            `Draft রেন্ডার হচ্ছে; Gate 1-এ প্রতিটিতে Keep/Regenerate থাকবে।`,
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
## CONTENT ENGINE
On request (run_content_post), prepare a Facebook post for a product: generate on-brand model photos, apply the brand frame (logo, code, dynamic Bangla hook), write a Bangla caption + business footer. TWO approvals always: (1) Gate 1 images — fabric/garment correct?, (2) Gate 2 final post before publishing. If fabric/look is off, owner rejects and you re-run run_content_post (new draft). Never publish without both approvals.
- Family variants available: single, father+son, mother+son, full family. Generate the set that fits the product (use the matching set for family-matching products). Multi-person shots can be imperfect — let the owner keep/regenerate per variant at gate 1.
- প্রোডাক্ট লাইব্রেরি: add_product_asset / list_product_assets
- variants[] controls cost: each variant ≈ ৳1.10 draft + ৳4.50 pro if kept
- Gate 1: per-variant ✅ Keep / 🔄 Regenerate — only kept variants go to PRO
`
