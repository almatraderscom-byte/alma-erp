/**
 * CS13 — xAI Grok Imagine engine contract (shared UI + server + worker-payload).
 *
 * One engine, every image mode: `generate` hits /v1/images/generations,
 * everything else hits /v1/images/edits with 1–3 reference images and a
 * DETERMINISTIC prompt scaffold (owner rule: no LLM creative judgment —
 * scaffolds are fixed strings, the owner's own prompt rides on top).
 *
 * API surface (docs.x.ai): POST https://api.x.ai/v1/images/generations and
 * POST https://api.x.ai/v1/images/edits, Bearer XAI_API_KEY. Models:
 * grok-imagine-image (fast, ~$0.02) / grok-imagine-image-quality (~$0.05 1K,
 * ~$0.07 2K). Edits accept up to 3 reference images. Aspect ratios include
 * 1:1 / 3:4 / 4:3 / 9:16 / 16:9 / 2:3 / 3:2 / auto; resolution '1k' | '2k'.
 */
import type { StudioModeId } from './constants'

export const XAI_IMAGE_MODEL_QUALITY = 'grok-imagine-image-quality'
export const XAI_IMAGE_MODEL_FAST = 'grok-imagine-image'
export const XAI_MAX_EDIT_REFERENCES = 3

export type XaiImagineOp = 'generate' | 'edit'

/** Studio aspect values the UI offers → nearest xAI-supported ratio. */
const XAI_ASPECT_MAP: Record<string, string> = {
  '4:5': '3:4', // studio portrait default — xAI has no 4:5; 3:4 is the closest portrait
  '1:1': '1:1',
  '9:16': '9:16',
  '16:9': '16:9',
  '2:3': '2:3',
  '3:2': '3:2',
  '3:4': '3:4',
  '4:3': '4:3',
}

export function toXaiAspectRatio(studioAspect: string | undefined): string {
  return XAI_ASPECT_MAP[studioAspect ?? ''] ?? 'auto'
}

/** xAI tops out at 2k — the studio's 4k choice degrades honestly to 2k. */
export function toXaiResolution(studioResolution: string | undefined): '1k' | '2k' {
  return studioResolution === '1k' ? '1k' : '2k'
}

export function estimateXaiImageCostUsd(resolution: '1k' | '2k', n = 1): number {
  return (resolution === '2k' ? 0.07 : 0.05) * Math.max(1, n)
}

/**
 * Deterministic per-mode scaffold. The reference images are numbered in the
 * order they are sent; scaffolds refer to them explicitly so multi-image
 * edits stay unambiguous. Owner prompt + background prompt append after.
 */
const MODE_SCAFFOLDS: Record<Exclude<StudioModeId, 'generate' | 'image_to_video'>, string> = {
  product_to_model:
    'Reference image 1 is a clothing product photo. Create a professional fashion photoshoot of a Bangladeshi model wearing EXACTLY this product — preserve the garment\'s color, pattern, embroidery and cut faithfully. Natural pose, modest styling, clean commercial lighting.',
  try_on:
    'Reference image 1 shows a person; reference image 2 is a clothing product photo. Dress the person from image 1 in EXACTLY the outfit from image 2 — keep the person\'s face, body, pose and identity unchanged, and preserve the garment\'s color, pattern and cut faithfully. Photorealistic virtual try-on.',
  model_swap:
    'Reference image 1 is a fashion photo; reference image 2 shows a different person. Recreate image 1 with the person from image 2 as the model — keep the outfit, pose, background and lighting of image 1 exactly, only the model changes.',
  face_to_model:
    'Reference image 1 shows a face. Create a professional fashion photoshoot of a model with EXACTLY this face — preserve identity faithfully. Modest styling, clean commercial lighting.',
  edit:
    'Edit reference image 1 as instructed below. Change ONLY what the instruction asks for; keep everything else — faces, garments, composition, lighting — exactly as in the original.',
}

export type XaiRunBrief = {
  op: XaiImagineOp
  /** agent-files storage paths, in scaffold order (max 3) */
  referenceImagePaths: string[]
  prompt: string
}

/**
 * Build the op + ordered references + full prompt for a studio run on the
 * xAI engine. Throws prompt_required for generate/edit without owner text.
 */
export function buildXaiRunBrief(input: {
  mode: StudioModeId
  prompt?: string
  backgroundPrompt?: string
  familyPrompt?: string
  productImagePath?: string
  modelImagePath?: string
  sourceImagePath?: string
  faceReferencePath?: string
}): XaiRunBrief {
  const ownerText = [input.familyPrompt, input.prompt, input.backgroundPrompt]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(' ')

  if (input.mode === 'generate') {
    if (!ownerText) throw new Error('prompt_required')
    return { op: 'generate', referenceImagePaths: [], prompt: ownerText }
  }
  if (input.mode === 'image_to_video') throw new Error('invalid_mode')

  const refs: string[] = []
  switch (input.mode) {
    case 'product_to_model': {
      if (!input.productImagePath) throw new Error('product_image_required')
      refs.push(input.productImagePath)
      // optional model reference: scaffold stays valid — extra image only helps
      if (input.modelImagePath) refs.push(input.modelImagePath)
      break
    }
    case 'try_on': {
      const person = input.modelImagePath ?? input.sourceImagePath
      if (!person) throw new Error('model_image_required')
      if (!input.productImagePath) throw new Error('product_image_required')
      refs.push(person, input.productImagePath)
      break
    }
    case 'model_swap': {
      if (!input.sourceImagePath) throw new Error('source_image_required')
      const person = input.modelImagePath ?? input.faceReferencePath
      if (!person) throw new Error('model_image_required')
      refs.push(input.sourceImagePath, person)
      break
    }
    case 'face_to_model': {
      const face = input.faceReferencePath ?? input.modelImagePath
      if (!face) throw new Error('model_image_required')
      refs.push(face)
      break
    }
    case 'edit': {
      if (!input.sourceImagePath) throw new Error('source_image_required')
      if (!ownerText) throw new Error('prompt_required')
      refs.push(input.sourceImagePath)
      // optional extra references (combined listings): product photo rides as image 2
      if (input.productImagePath) refs.push(input.productImagePath)
      break
    }
  }
  if (refs.length > XAI_MAX_EDIT_REFERENCES) refs.length = XAI_MAX_EDIT_REFERENCES

  const scaffold = MODE_SCAFFOLDS[input.mode]
  return {
    op: 'edit',
    referenceImagePaths: refs,
    prompt: [scaffold, ownerText].filter(Boolean).join(' '),
  }
}

// ── Templates (x.ai-console style "start from a template") ───────────────────

export type XaiTemplate = {
  id: string
  labelBn: string
  hintBn: string
  mode: StudioModeId
  /** prefill for the owner's prompt box (editable before Run) */
  prompt: string
  aspectRatio: string
  resolution: '1k' | '2k'
}

/** Owner-facing template presets — deterministic prefills, never auto-run. */
export const XAI_TEMPLATES: XaiTemplate[] = [
  {
    id: 'product_launch',
    labelBn: 'প্রোডাক্ট লঞ্চ ভিজ্যুয়াল',
    hintBn: 'নতুন প্রোডাক্টের পলিশড ক্যাম্পেইন ছবি (টেক্সট থেকে)',
    mode: 'generate',
    prompt:
      'Premium product launch campaign visual for a Bangladeshi clothing brand: elegant fabric draping, soft studio light, festive yet modest aesthetic, no people, space for headline text.',
    aspectRatio: '4:5',
    resolution: '2k',
  },
  {
    id: 'social_content',
    labelBn: 'সোশ্যাল মিডিয়া কনটেন্ট',
    hintBn: 'অন-ব্র্যান্ড গ্রাফিক (টেক্সট থেকে)',
    mode: 'generate',
    prompt:
      'On-brand social media graphic for a Bangladeshi lifestyle brand: warm coral and cream palette, clean modern composition, tasteful festive mood, no text.',
    aspectRatio: '1:1',
    resolution: '1k',
  },
  {
    id: 'product_display',
    labelBn: 'প্রোডাক্ট ডিসপ্লে ছবি',
    hintBn: 'সাধারণ ছবি → প্রফেশনাল লিস্টিং (১ রেফারেন্স)',
    mode: 'edit',
    prompt:
      'Turn this amateur product photo into a professional e-commerce listing image: clean neutral backdrop, studio lighting, product perfectly centered and unchanged.',
    aspectRatio: '1:1',
    resolution: '2k',
  },
  {
    id: 'virtual_try_on',
    labelBn: 'ভার্চুয়াল ট্রাই-অন',
    hintBn: 'মডেল + পোশাক → পরানো ছবি (২ রেফারেন্স)',
    mode: 'try_on',
    prompt: '',
    aspectRatio: '4:5',
    resolution: '2k',
  },
  {
    id: 'product_to_model',
    labelBn: 'প্রোডাক্ট টু মডেল',
    hintBn: 'পোশাকের ছবি → মডেলের গায়ে ফটোশুট',
    mode: 'product_to_model',
    prompt: '',
    aspectRatio: '4:5',
    resolution: '2k',
  },
  {
    id: 'combined_listing',
    labelBn: 'কম্বাইন্ড লিস্টিং',
    hintBn: 'একাধিক প্রোডাক্ট এক ছবিতে (এডিট প্রম্পটে লিখুন)',
    mode: 'edit',
    prompt:
      'Combine the products into one cohesive professional listing photo on a single clean surface with consistent studio lighting.',
    aspectRatio: '1:1',
    resolution: '2k',
  },
]
