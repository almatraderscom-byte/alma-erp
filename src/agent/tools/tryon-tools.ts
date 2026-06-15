import { prisma } from '@/lib/prisma'
import {
  getModelLibrary,
  addBrandModel,
  removeBrandModel,
  setDefaultBrandModel,
  resolveModel,
  buildTryOnPrompt,
  listModelsByRole,
  type SavedModel,
  type TryOnStyle,
  type TryOnPose,
  type ModelRole,
} from '@/lib/tryon/model-library'
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
      action: { type: 'string', enum: ['list', 'add', 'remove', 'set_default', 'list_by_role'] },
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
    'Virtual try-on: put a PRODUCT (from a product photo) onto one of ALMA\'s SAVED MODELS, with a realistic ' +
    'Bangladesh-photoshoot background. Owner gives the product image (productImagePath) and optionally which ' +
    'model, style, and pose. The agent builds the expert prompt automatically — owner does NOT write image ' +
    'prompts. Creates a PENDING ACTION; owner must approve before rendering. Use this (not generate_image) ' +
    'whenever the owner wants a product shown on a model.',
  input_schema: {
    type: 'object' as const,
    properties: {
      productImagePath: {
        type: 'string',
        description: 'agent-files storage path of the product photo (the reseller image with the garment)',
      },
      modelId: { type: 'string', description: 'Which saved model (id or name). Omit to use the default model.' },
      style: {
        type: 'string',
        enum: ['studio', 'outdoor_bd', 'festival', 'lifestyle'],
        description: 'Background/scene style. Default studio.',
      },
      pose: {
        type: 'string',
        enum: ['front', 'three_quarter', 'walking', 'sitting', 'detail'],
        description: 'Default front.',
      },
      garmentType: { type: 'string', description: 'Optional garment description, e.g. "premium silk panjabi" — improves accuracy.' },
      extra: { type: 'string', description: 'Optional free-text tweak from owner, e.g. "festive mood, slight smile".' },
      conversationId: { type: 'string' },
    },
    required: ['productImagePath'],
  },
  handler: async (input) => {
    const productImagePath = String(input.productImagePath ?? '').trim()
    if (!productImagePath) return { success: false, error: 'productImagePath লাগবে।' }

    const model = await resolveModel(input.modelId ? String(input.modelId) : undefined)
    if (!model) {
      return {
        success: false,
        error: 'কোনো saved মডেল নেই। আগে manage_model_library (action=add, role=...) দিয়ে মডেল ছবি যোগ করুন।',
      }
    }

    const prompt = buildTryOnPrompt({
      style: input.style as TryOnStyle | undefined,
      pose: input.pose as TryOnPose | undefined,
      modelNotes: model.notes,
      garmentType: input.garmentType ? String(input.garmentType) : undefined,
      extra: input.extra ? String(input.extra) : undefined,
    })

    const summary =
      `🧍 On-model try-on (pro)\n` +
      `মডেল: ${model.name}${model.role ? ` (${model.role})` : ''}\n` +
      `স্টাইল: ${input.style ?? 'studio'} | পোজ: ${input.pose ?? 'front'}\n` +
      `প্রোডাক্ট: ${productImagePath.split('/').pop()}`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const action = await (prisma as any).agentPendingAction.create({
      data: {
        conversationId: input.conversationId ? String(input.conversationId) : null,
        type: 'image_gen',
        payload: {
          prompt,
          quality: 'pro',
          referenceImageId: model.imagePath,
          secondReferenceImageId: productImagePath,
          tryOn: true,
          conversationId: input.conversationId ?? null,
        },
        summary,
        costEstimate: 4.5,
        status: 'pending',
      },
    })

    return {
      success: true,
      data: {
        pendingActionId: action.id,
        summary,
        message: 'Try-on request তৈরি — owner approve করলে রেন্ডার হবে।',
      },
    }
  },
}

export const TRYON_TOOLS: AgentTool[] = [manage_model_library, generate_on_model_image]

export const TRYON_ROLE_PROMPT = `
## ব্র্যান্ড মডেল লাইব্রেরি (আগে সেটআপ — content engine-এর জন্য বাধ্যতামূলক)
owner full-body ছবি আপলোড করলে → manage_model_library (action=add, role=father|mother|son|daughter|single)।
এক role-এ এক মডেল — নতুন add করলে সেই role আপডেট হয়।
list_by_role দিয়ে কোন role আছে/নেই দেখুন। father+son+mother+daughter স্টক করলে family-matching পোস্ট ভালো হয়।
ছবির টিপস: full body, সামনে/হালকা কোণ, plain background, ভালো আলো, heavy filter নয়।

## ভার্চুয়াল ট্রাই-অন
owner প্রোডাক্ট ছবি দিলে এবং মডেলে দেখাতে চাইলে → generate_on_model_image (generate_image নয়)।
- owner image prompt লিখবেন না — style/pose আপনি বেছে expert prompt বানাবেন।
- background বাস্তব বাংলাদেশি ফটোশুট-টাইপ — built-in।
- garment ৯৯% হুবহু রাখতে হবে।
`
