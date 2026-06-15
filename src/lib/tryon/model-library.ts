import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const KV_KEY = 'tryon_model_library'
const VALID_ROLES = new Set(['father', 'mother', 'son', 'daughter', 'single'])

export type ModelRole = 'father' | 'mother' | 'son' | 'daughter' | 'single'

export type SavedModel = {
  id: string
  name: string
  imagePath: string
  isDefault: boolean
  notes?: string
  role?: ModelRole
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

function mapRow(row: {
  id: string
  name: string
  imagePath: string
  isDefault: boolean
  notes: string | null
  role: string | null
}): SavedModel {
  return {
    id: row.id,
    name: row.name,
    imagePath: row.imagePath,
    isDefault: row.isDefault,
    notes: row.notes ?? undefined,
    role: row.role && VALID_ROLES.has(row.role) ? (row.role as ModelRole) : undefined,
  }
}

/** One-time import from legacy KV JSON into agent_brand_models. */
async function migrateKvToDbIfNeeded(): Promise<void> {
  const count = await db.agentBrandModel.count()
  if (count > 0) return

  const row = await db.agentKvSetting.findUnique({ where: { key: KV_KEY } })
  if (!row?.value) return

  let parsed: SavedModel[] = []
  try {
    const raw = JSON.parse(row.value)
    if (Array.isArray(raw)) parsed = raw
  } catch {
    return
  }

  for (const m of parsed) {
    if (!m?.id || !m?.name || !m?.imagePath) continue
    try {
      await db.agentBrandModel.create({
        data: {
          id: m.id,
          name: m.name,
          imagePath: m.imagePath,
          isDefault: Boolean(m.isDefault),
          notes: m.notes ?? null,
          role: m.role && VALID_ROLES.has(m.role) ? m.role : null,
        },
      })
    } catch {
      /* skip duplicate */
    }
  }
}

export async function getModelLibrary(): Promise<SavedModel[]> {
  await migrateKvToDbIfNeeded()
  const rows = await db.agentBrandModel.findMany({ orderBy: { createdAt: 'asc' } })
  return rows.map(mapRow)
}

/** @deprecated Prefer addBrandModel / removeBrandModel — kept for compatibility. */
export async function setModelLibrary(models: SavedModel[]): Promise<void> {
  await db.agentBrandModel.deleteMany({})
  if (!models.length) return
  await db.agentBrandModel.createMany({
    data: models.map((m) => ({
      id: m.id,
      name: m.name,
      imagePath: m.imagePath,
      isDefault: m.isDefault,
      notes: m.notes ?? null,
      role: m.role && VALID_ROLES.has(m.role) ? m.role : null,
    })),
    skipDuplicates: true,
  })
}

export async function addBrandModel(model: SavedModel): Promise<SavedModel> {
  await migrateKvToDbIfNeeded()

  if (model.role && VALID_ROLES.has(model.role)) {
    await db.agentBrandModel.deleteMany({ where: { role: model.role } })
  }

  const count = await db.agentBrandModel.count()
  const isDefault = model.isDefault || count === 0

  if (isDefault) {
    await db.agentBrandModel.updateMany({ data: { isDefault: false } })
  }

  const row = await db.agentBrandModel.upsert({
    where: { id: model.id },
    create: {
      id: model.id,
      name: model.name,
      imagePath: model.imagePath,
      isDefault,
      notes: model.notes ?? null,
      role: model.role && VALID_ROLES.has(model.role) ? model.role : null,
    },
    update: {
      name: model.name,
      imagePath: model.imagePath,
      isDefault,
      notes: model.notes ?? null,
      role: model.role && VALID_ROLES.has(model.role) ? model.role : null,
    },
  })

  return mapRow(row)
}

export async function removeBrandModel(id: string): Promise<boolean> {
  const existing = await db.agentBrandModel.findUnique({ where: { id } })
  if (!existing) return false
  await db.agentBrandModel.delete({ where: { id } })
  if (existing.isDefault) {
    const next = await db.agentBrandModel.findFirst({ orderBy: { createdAt: 'asc' } })
    if (next) {
      await db.agentBrandModel.update({ where: { id: next.id }, data: { isDefault: true } })
    }
  }
  return true
}

export async function setDefaultBrandModel(id: string): Promise<boolean> {
  const existing = await db.agentBrandModel.findUnique({ where: { id } })
  if (!existing) return false
  await db.agentBrandModel.updateMany({ data: { isDefault: false } })
  await db.agentBrandModel.update({ where: { id }, data: { isDefault: true } })
  return true
}

export async function getDefaultModel(): Promise<SavedModel | null> {
  await migrateKvToDbIfNeeded()
  const row = await db.agentBrandModel.findFirst({
    where: { isDefault: true },
    orderBy: { createdAt: 'asc' },
  })
  if (row) return mapRow(row)
  const first = await db.agentBrandModel.findFirst({ orderBy: { createdAt: 'asc' } })
  return first ? mapRow(first) : null
}

export async function resolveModel(idOrName?: string): Promise<SavedModel | null> {
  await migrateKvToDbIfNeeded()
  if (!idOrName) return getDefaultModel()
  const q = idOrName.toLowerCase().trim()
  const byId = await db.agentBrandModel.findUnique({ where: { id: q } })
  if (byId) return mapRow(byId)
  const lib = await getModelLibrary()
  return lib.find((m) => m.name.toLowerCase().includes(q)) ?? null
}

export async function getModelByRole(role: ModelRole): Promise<SavedModel | null> {
  await migrateKvToDbIfNeeded()
  const row = await db.agentBrandModel.findFirst({ where: { role } })
  if (row) return mapRow(row)
  if (role === 'single') {
    const father = await db.agentBrandModel.findFirst({ where: { role: 'father' } })
    if (father) return mapRow(father)
    return getDefaultModel()
  }
  return getDefaultModel()
}

/** Alias kept for content-engine callers. */
export const resolveModelByRole = getModelByRole

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

export function buildFamilyVariantExtra(variant: string, fabric?: string): string {
  const fabricNote = fabric ? `Garment fabric/details: ${fabric}.` : ''
  if (variant === 'father_son') {
    return [
      'COMPOSITION: Bangladeshi father (age 35-45) and young son (age 8-12) standing together in ONE scene,',
      'both wearing matching coordinated outfits from the product reference — family fashion shoot.',
      fabricNote,
    ].filter(Boolean).join(' ')
  }
  if (variant === 'mother_son') {
    return [
      'COMPOSITION: Bangladeshi mother and young son together in ONE scene, matching family outfits from the product.',
      fabricNote,
    ].filter(Boolean).join(' ')
  }
  if (variant === 'full_family') {
    return [
      'COMPOSITION: Full Bangladeshi family (father, mother, son, daughter) together in ONE scene,',
      'all wearing matching coordinated outfits from the product reference.',
      fabricNote,
    ].filter(Boolean).join(' ')
  }
  return fabricNote
}

export async function listModelsByRole(): Promise<Partial<Record<ModelRole, SavedModel>>> {
  const lib = await getModelLibrary()
  const out: Partial<Record<ModelRole, SavedModel>> = {}
  for (const m of lib) {
    if (m.role) out[m.role] = m
  }
  return out
}
