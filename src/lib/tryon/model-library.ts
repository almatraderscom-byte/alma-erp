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

export type { TryOnStyle, TryOnPose, GarmentAttrs, GarmentType } from '@/lib/tryon/art-director'
export {
  BD_REALISM_BASE,
  STYLE_DIRECTION,
  POSE_DIRECTION,
  buildTryOnPrompt,
  buildArtDirectorPrompt,
  getOrClassifyGarment,
  classifyGarment,
  normalizeGarmentType,
} from '@/lib/tryon/art-director'

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

  let q = idOrName.trim().toLowerCase()
  q = q.replace(/^model\s+/i, '').replace(/^মডেল\s+/i, '').replace(/\s+/g, ' ')
  const slug = q.replace(/\s+/g, '-')

  const byId = await db.agentBrandModel.findUnique({ where: { id: slug } })
  if (byId) return mapRow(byId)

  const lib = await getModelLibrary()
  const exact = lib.find((m) => m.name.toLowerCase() === q || m.id === slug)
  if (exact) return exact

  const tokens = q.split(/[\s-]+/).filter(Boolean)
  return (
    lib.find((m) => {
      const hay = `${m.name} ${m.id} ${m.role ?? ''}`.toLowerCase()
      return tokens.every((t) => hay.includes(t)) || hay.includes(q)
    }) ?? null
  )
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
      'COMPOSITION: Bangladeshi mother and young son (age 5–12) together in ONE scene, matching family outfits from the product.',
      fabricNote,
    ].filter(Boolean).join(' ')
  }
  if (variant === 'mother_daughter') {
    return [
      'COMPOSITION: Bangladeshi mother and young daughter (age 5–10) together in ONE scene,',
      'both wearing matching coordinated outfits from the product reference — family fashion shoot.',
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
