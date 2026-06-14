import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const KV_KEY = 'tryon_model_library'

export type SavedModel = {
  id: string
  name: string
  imagePath: string
  isDefault: boolean
  notes?: string
}

export type TryOnStyle = 'studio' | 'outdoor_bd' | 'festival' | 'lifestyle'
export type TryOnPose = 'front' | 'three_quarter' | 'walking' | 'sitting' | 'detail'

const BD_REALISM_BASE =
  'Photorealistic professional fashion photograph shot in Bangladesh. ' +
  'Natural South Asian (Bangladeshi) setting and lighting, authentic local environment, ' +
  'realistic skin tones for a Bangladeshi person, true-to-life fabric drape and texture. ' +
  'Shot on a full-frame DSLR, 85mm lens, shallow depth of field, soft natural light. ' +
  'NOT a foreign/Western studio look — the background, light quality, and overall mood must read as a real Bangladeshi photoshoot. ' +
  'High resolution, sharp focus on the garment, e-commerce ready.'

const STYLE_DIRECTION: Record<TryOnStyle, string> = {
  studio:
    'Clean professional studio backdrop in soft neutral tone (warm off-white or muted), even softbox lighting, minimal shadows — classic e-commerce on-model shot.',
  outdoor_bd:
    'Real Bangladeshi outdoor location — e.g. an old Dhaka street, a heritage building courtyard, a rooftop at golden hour, or lush greenery. Authentic local architecture and ambience, natural daylight.',
  festival:
    'Warm festive Bangladeshi setting suitable for Eid/wedding — tasteful decorative elements, warm golden ambient light, celebratory but not cluttered; keeps full focus on the outfit.',
  lifestyle:
    'Candid lifestyle scene in a relatable Bangladeshi everyday setting (cafe, home interior, urban street), natural and unposed feel.',
}

const POSE_DIRECTION: Record<TryOnPose, string> = {
  front: 'Model facing camera, full front view, relaxed confident posture, full outfit clearly visible.',
  three_quarter: "Model at a three-quarter angle, showing the garment's silhouette and side drape.",
  walking: 'Model captured mid-stride walking toward camera, natural movement, fabric in motion.',
  sitting: 'Model seated in a natural, elegant pose, garment arranged to show its fit and detail.',
  detail: 'Closer framing emphasizing fabric texture, embroidery, and craftsmanship of the garment.',
}

export async function getModelLibrary(): Promise<SavedModel[]> {
  const row = await db.agentKvSetting.findUnique({ where: { key: KV_KEY } })
  if (!row?.value) return []
  try {
    const parsed = JSON.parse(row.value)
    if (Array.isArray(parsed)) return parsed
  } catch {
    /* ignore */
  }
  return []
}

export async function setModelLibrary(models: SavedModel[]): Promise<void> {
  await db.agentKvSetting.upsert({
    where: { key: KV_KEY },
    create: { key: KV_KEY, value: JSON.stringify(models) },
    update: { value: JSON.stringify(models) },
  })
}

export async function getDefaultModel(): Promise<SavedModel | null> {
  const lib = await getModelLibrary()
  return lib.find((m) => m.isDefault) ?? lib[0] ?? null
}

export async function resolveModel(idOrName?: string): Promise<SavedModel | null> {
  const lib = await getModelLibrary()
  if (!idOrName) return getDefaultModel()
  const q = idOrName.toLowerCase().trim()
  return lib.find((m) => m.id.toLowerCase() === q || m.name.toLowerCase().includes(q)) ?? null
}

export function buildTryOnPrompt(opts: {
  style?: TryOnStyle
  pose?: TryOnPose
  modelNotes?: string
  garmentType?: string
  extra?: string
}): string {
  const style = STYLE_DIRECTION[opts.style ?? 'studio']
  const pose = POSE_DIRECTION[opts.pose ?? 'front']
  const garment = opts.garmentType ? `The garment is a ${opts.garmentType}.` : ''
  const modelNote = opts.modelNotes ? `Model characteristics: ${opts.modelNotes}.` : ''
  const extra = opts.extra ? `Additional direction: ${opts.extra}.` : ''

  return [
    'TASK: Virtual try-on. Image 1 is the MODEL (a real person). Image 2 is the PRODUCT/garment (currently worn by a different model).',
    'Take the exact garment from Image 2 and dress the MODEL from Image 1 in it. ',
    'CRITICAL: Preserve the garment from Image 2 with 99% accuracy — exact color, pattern, fabric, embroidery, cut, buttons, and all design details must match the product photo precisely. Do NOT redesign or stylize the garment.',
    "Preserve the MODEL's identity (face, body type, skin tone) from Image 1. Fit the garment naturally and realistically to this model's body.",
    garment,
    modelNote,
    BD_REALISM_BASE,
    `Composition: ${style}`,
    `Pose: ${pose}`,
    extra,
  ]
    .filter(Boolean)
    .join(' ')
}
