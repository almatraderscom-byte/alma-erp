import {
  getModelLibrary,
  addBrandModel,
  removeBrandModel,
  setDefaultBrandModel,
  listModelsByRole,
  type TryOnStyle,
  type TryOnPose,
  type ModelRole,
} from '@/lib/tryon/model-library'
import { CHAT_TRYON_VARIANTS, queueTryOnBatch, type ChatTryOnVariant } from '@/lib/tryon/tryon-batch'
import type { AgentTool } from './registry'

const VALID_ROLES: ModelRole[] = ['father', 'mother', 'son', 'daughter', 'single']

const manage_model_library: AgentTool = {
  name: 'manage_model_library',
  description:
    'View, add, remove, or set-default ALMA brand model photos (used for try-on + content engine). ' +
    'Owner uploads a full-body photo in chat, then asks to save with a role (father/mother/son/daughter/single). ' +
    'imagePath must be the agent-files storage path from that upload. One model per role — adding the same role replaces the previous.',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'set_default', 'list_by_role'], description: 'Model-library operation to perform' },
      id: { type: 'string', description: 'Short slug, e.g. "maruf-father" (add/remove/set_default)' },
      name: { type: 'string', description: 'Display name (add)' },
      imagePath: { type: 'string', description: 'agent-files storage path of the uploaded model photo (add)' },
      notes: { type: 'string', description: 'Optional: age range / body type — helps fit accuracy' },
      role: {
        type: 'string',
        enum: VALID_ROLES,
        description: 'Family role — required for content engine (father, mother, son, daughter, or single)',
      },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const action = String(input.action ?? '')

    if (action === 'list') {
      const lib = await getModelLibrary()
      return {
        success: true,
        data: {
          models: lib.map((m) => ({
            id: m.id,
            name: m.name,
            role: m.role ?? null,
            isDefault: m.isDefault,
            notes: m.notes,
          })),
        },
      }
    }

    if (action === 'list_by_role') {
      const byRole = await listModelsByRole()
      return {
        success: true,
        data: {
          father: byRole.father ?? null,
          mother: byRole.mother ?? null,
          son: byRole.son ?? null,
          daughter: byRole.daughter ?? null,
          single: byRole.single ?? null,
        },
      }
    }

    if (action === 'add') {
      const id = String(input.id ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
      const name = String(input.name ?? '').trim()
      const imagePath = String(input.imagePath ?? '').trim()
      const role = input.role ? (String(input.role) as ModelRole) : undefined
      if (!id || !name || !imagePath) {
        return { success: false, error: 'add-এর জন্য id, name, imagePath লাগবে।' }
      }
      if (!role) {
        return { success: false, error: 'content engine-এর জন্য role লাগবে (father/mother/son/daughter/single)।' }
      }

      const saved = await addBrandModel({
        id,
        name,
        imagePath,
        isDefault: false,
        notes: input.notes ? String(input.notes) : undefined,
        role,
      })

      return {
        success: true,
        data: {
          message: `মডেল "${name}" যুক্ত হয়েছে (role: ${role})${saved.isDefault ? ' — default' : ''}।`,
          model: { id: saved.id, name: saved.name, role: saved.role, isDefault: saved.isDefault },
        },
      }
    }

    if (action === 'remove') {
      const id = String(input.id ?? '').trim().toLowerCase()
      const ok = await removeBrandModel(id)
      if (!ok) return { success: false, error: `"${id}" পাওয়া যায়নি।` }
      return { success: true, data: { message: `"${id}" সরানো হয়েছে।` } }
    }

    if (action === 'set_default') {
      const id = String(input.id ?? '').trim().toLowerCase()
      const ok = await setDefaultBrandModel(id)
      if (!ok) return { success: false, error: `"${id}" পাওয়া যায়নি।` }
      return { success: true, data: { message: `"${id}" এখন default মডেল।` } }
    }

    return { success: false, error: `invalid action: ${action}` }
  },
}

const generate_on_model_image: AgentTool = {
  name: 'generate_on_model_image',
  description:
    'Virtual try-on: PRODUCT photo onto a SAVED MODEL. Owner says "Model Maruf" → resolve modelId. ' +
    'Garment 99% unchanged from product; face/body from model reference. Pending approval before render. ' +
    'Use generate_on_model_batch for family matching (ma-meye, baba-chele, etc.).',
  input_schema: {
    type: 'object' as const,
    properties: {
      productImagePath: { type: 'string', description: 'Product/reseller/mannequin photo path' },
      modelId: { type: 'string', description: 'Model name or id, e.g. "Maruf", "model-maruf"' },
      style: { type: 'string', enum: ['studio', 'outdoor_bd', 'festival', 'lifestyle'], description: 'Scene style for the render' },
      pose: { type: 'string', enum: ['front', 'three_quarter', 'walking', 'sitting', 'detail'], description: 'Model pose' },
      garmentType: { type: 'string', description: 'Garment type, e.g. panjabi, saree (helps fit accuracy)' },
      extra: { type: 'string', description: 'Extra render instruction (optional)' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['productImagePath'],
  },
  handler: async (input) => {
    const productImagePath = String(input.productImagePath ?? '').trim()
    if (!productImagePath) return { success: false, error: 'productImagePath লাগবে।' }
    try {
      const { items, model } = await queueTryOnBatch({
        productImagePath,
        modelId: input.modelId ? String(input.modelId) : undefined,
        variants: ['single'],
        style: input.style as TryOnStyle | undefined,
        pose: input.pose as TryOnPose | undefined,
        garmentType: input.garmentType ? String(input.garmentType) : undefined,
        extra: input.extra ? String(input.extra) : undefined,
        conversationId: input.conversationId ? String(input.conversationId) : null,
      })
      const item = items[0]
      return {
        success: true,
        data: {
          pendingActionId: item.pendingActionId,
          summary: item.summary,
          model: model.name,
          message: 'Try-on request তৈরি — owner approve করলে রেন্ডার হবে।',
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no_model')) {
        return {
          success: false,
          error: 'কোনো saved মডেল নেই। manage_model_library (action=add) দিয়ে আগে save করুন।',
        }
      }
      return { success: false, error: msg }
    }
  },
}

const generate_on_model_batch: AgentTool = {
  name: 'generate_on_model_batch',
  description:
    'Multiple try-on renders from ONE product — single, father_son, mother_son, mother_daughter, full_family. ' +
    'Each variant = separate approval card. For matching family sets with child age 5–10.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productImagePath: { type: 'string', description: 'Storage path of the product photo (from get_product)' },
      modelId: { type: 'string', description: 'Override for single variant' },
      variants: {
        type: 'array',
        items: { type: 'string', enum: CHAT_TRYON_VARIANTS },
        description: 'Which try-on variants to render (each becomes its own approval card)',
      },
      style: { type: 'string', enum: ['studio', 'outdoor_bd', 'festival', 'lifestyle'], description: 'Scene style for the render' },
      pose: { type: 'string', enum: ['front', 'three_quarter', 'walking', 'sitting', 'detail'], description: 'Model pose' },
      extra: { type: 'string', description: 'Extra render instruction (optional)' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['productImagePath'],
  },
  handler: async (input) => {
    const productImagePath = String(input.productImagePath ?? '').trim()
    if (!productImagePath) return { success: false, error: 'productImagePath লাগবে।' }
    const variants = Array.isArray(input.variants)
      ? (input.variants as ChatTryOnVariant[])
      : (['single'] as ChatTryOnVariant[])
    try {
      const { items, model } = await queueTryOnBatch({
        productImagePath,
        modelId: input.modelId ? String(input.modelId) : undefined,
        variants,
        style: input.style as TryOnStyle | undefined,
        pose: input.pose as TryOnPose | undefined,
        extra: input.extra ? String(input.extra) : undefined,
        conversationId: input.conversationId ? String(input.conversationId) : null,
      })
      return {
        success: true,
        data: {
          count: items.length,
          pendingActionIds: items.map((i) => i.pendingActionId),
          summaries: items.map((i) => i.summary),
          model: model.name,
          message: `${items.length}টি try-on card — প্রতিটি approve করুন।`,
        },
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('no_model')) {
        return { success: false, error: 'role অনুযায়ী মডেল missing — list_by_role চেক করুন।' }
      }
      return { success: false, error: msg }
    }
  },
}

export const TRYON_TOOLS: AgentTool[] = [
  manage_model_library,
  generate_on_model_image,
  generate_on_model_batch,
]

export const TRYON_ROLE_PROMPT = `
## ব্র্যান্ড মডেল লাইব্রেরি + virtual try-on (designer brain)
Workflow: owner product/mannequin ছবি + নিজের full-body ছবি → manage_model_library (add, name="Maruf", role=...) save।
তারপর "Model Maruf use koro" / "ei product e amar model boshao" → generate_on_model_image বা generate_on_model_batch।

Image 1 = saved model (face identity), Image 2 = product (garment 99% unchanged)। Owner prompt লিখবেন না।

Family matching: mother_daughter (মা+মেয়ে ৫–১০), father_son, mother_son, full_family → generate_on_model_batch variants।
list_by_role দিয়ে father/mother/son/daughter stock আছে কিনা দেখুন।
`
