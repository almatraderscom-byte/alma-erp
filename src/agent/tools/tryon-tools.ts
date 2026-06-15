import { prisma } from '@/lib/prisma'
import {
  getModelLibrary,
  setModelLibrary,
  resolveModel,
  buildTryOnPrompt,
  type SavedModel,
  type TryOnStyle,
  type TryOnPose,
  type ModelRole,
} from '@/lib/tryon/model-library'
import type { AgentTool } from './registry'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const manage_model_library: AgentTool = {
  name: 'manage_model_library',
  description:
    'View, add, remove, or set-default ALMA\'s saved try-on models (reference photos used to put products ' +
    'on a model). Add only when the owner uploads a model photo and asks to save it. The imagePath must be ' +
    'an agent-files storage path of an already-uploaded photo (the owner uploads via the chat; use the ' +
    'storage path returned from that upload).',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', enum: ['list', 'add', 'remove', 'set_default'] },
      id: { type: 'string', description: 'Short slug for the model, e.g. "maruf" (add/remove/set_default)' },
      name: { type: 'string', description: 'Display name (add)' },
      imagePath: { type: 'string', description: 'agent-files storage path of the uploaded model photo (add)' },
      notes: { type: 'string', description: 'Optional: body type / gender / age range — helps fit accuracy' },
      role: {
        type: 'string',
        enum: ['father', 'mother', 'son', 'daughter', 'single'],
        description: 'Family role for content engine composition (add)',
      },
    },
    required: ['action'],
  },
  handler: async (input) => {
    const action = String(input.action ?? '')
    const lib = await getModelLibrary()

    if (action === 'list') {
      return {
        success: true,
        data: { models: lib.map((m) => ({ id: m.id, name: m.name, isDefault: m.isDefault, notes: m.notes })) },
      }
    }
    if (action === 'add') {
      const id = String(input.id ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
      const name = String(input.name ?? '').trim()
      const imagePath = String(input.imagePath ?? '').trim()
      if (!id || !name || !imagePath) return { success: false, error: 'add-এর জন্য id, name, imagePath লাগবে।' }
      if (lib.some((m) => m.id === id)) return { success: false, error: `"${id}" আইডি ইতোমধ্যে আছে।` }
      const model: SavedModel = {
        id,
        name,
        imagePath,
        isDefault: lib.length === 0,
        notes: input.notes ? String(input.notes) : undefined,
        role: input.role ? (String(input.role) as SavedModel['role']) : undefined,
      }
      await setModelLibrary([...lib, model])
      return {
        success: true,
        data: {
          message: `মডেল "${name}" যুক্ত হয়েছে${model.isDefault ? ' (default)' : ''}।`,
          models: [...lib, model].map((m) => ({ id: m.id, name: m.name, isDefault: m.isDefault })),
        },
      }
    }
    if (action === 'remove') {
      const id = String(input.id ?? '')
        .trim()
        .toLowerCase()
      const updated = lib.filter((m) => m.id !== id)
      if (updated.length === lib.length) return { success: false, error: `"${id}" পাওয়া যায়নি।` }
      if (!updated.some((m) => m.isDefault) && updated.length) updated[0].isDefault = true
      await setModelLibrary(updated)
      return { success: true, data: { message: `"${id}" সরানো হয়েছে।` } }
    }
    if (action === 'set_default') {
      const id = String(input.id ?? '')
        .trim()
        .toLowerCase()
      if (!lib.some((m) => m.id === id)) return { success: false, error: `"${id}" পাওয়া যায়নি।` }
      const updated = lib.map((m) => ({ ...m, isDefault: m.id === id }))
      await setModelLibrary(updated)
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
        error: 'কোনো saved মডেল নেই। আগে manage_model_library (action=add) দিয়ে একটি মডেল ছবি যোগ করুন।',
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
      `মডেল: ${model.name}\n` +
      `স্টাইল: ${input.style ?? 'studio'} | পোজ: ${input.pose ?? 'front'}\n` +
      `প্রোডাক্ট: ${productImagePath.split('/').pop()}`

    const action = await db.agentPendingAction.create({
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
## ভার্চুয়াল ট্রাই-অন (নিজের মডেলে প্রোডাক্ট)
owner প্রোডাক্ট ছবি দিলে এবং মডেলে দেখাতে চাইলে → generate_on_model_image ব্যবহার করুন (generate_image নয়)।
- owner কোনো hard image prompt লিখবেন না — আপনি style/pose বেছে expert prompt নিজে বানাবেন।
- default saved মডেল ব্যবহার হবে; owner অন্য মডেল/পোজ/স্টাইল বললে সেই অনুযায়ী।
- background সবসময় বাস্তব বাংলাদেশি ফটোশুট-টাইপ (বিদেশি generic নয়) — এটা built-in।
- নতুন মডেল ছবি owner আপলোড করে "এটা সেভ করো" বললে → manage_model_library (action=add)।
- প্রোডাক্ট garment ৯৯% হুবহু রাখতে হবে — রঙ/প্যাটার্ন/ডিটেইল বদলাবে না; শুধু মডেলের গায়ে fit হবে।
`
