import { roundMoney } from '@/lib/money'
import { asRecord, ProjectContractError, slugifyAssetTag } from '@/lib/creative-studio/project-contract'

export const RECIPE_QC_LEVELS = ['off', 'normal', 'strict'] as const
export const RECIPE_MODEL_ROLES = ['single', 'father', 'mother', 'son', 'daughter'] as const
export const RECIPE_ASPECTS = ['1:1', '4:5', '9:16', '16:9'] as const

export type RecipeQcLevel = (typeof RECIPE_QC_LEVELS)[number]

export type BrandRecipeInput = {
  brandProfileId: string | null
  brandName: string
  recipeKey: string | null
  name: string
  sceneSubset: string[]
  modelRoles: string[]
  finishTheme: string
  captionTone: string
  aspectPack: string[]
  musicVibe: string
  qcLevel: RecipeQcLevel
  spendCeilingBdt: number
}

type RecipeLike = {
  lockedAt?: Date | string | null
  version?: number | null
  recipeKey?: string | null
}

function text(value: unknown, max: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback
  return value.trim().replace(/\s+/g, ' ').slice(0, max)
}

function textList(value: unknown, maxItems: number, maxLength: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of raw) {
    const clean = text(item, maxLength)
    const key = clean.toLocaleLowerCase('bn-BD')
    if (!clean || seen.has(key)) continue
    seen.add(key)
    result.push(clean)
    if (result.length >= maxItems) break
  }
  return result
}

function oneOf<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : fallback
}

export function normalizeBrandRecipeInput(value: unknown): BrandRecipeInput {
  const body = asRecord(value)
  const name = text(body.name, 80)
  if (name.length < 2) throw new ProjectContractError('recipe_name_required')

  const modelRoles = textList(body.modelRoles, 5, 24)
    .filter((role) => (RECIPE_MODEL_ROLES as readonly string[]).includes(role))
  const aspectPack = textList(body.aspectPack, 4, 8)
    .filter((aspect) => (RECIPE_ASPECTS as readonly string[]).includes(aspect))
  const spend = Number(body.spendCeilingBdt ?? 0)
  if (!Number.isFinite(spend) || spend < 0 || spend > 100_000) {
    throw new ProjectContractError('invalid_spend_ceiling')
  }

  const suppliedKey = text(body.recipeKey, 64)
  const recipeKey = suppliedKey ? slugifyAssetTag(suppliedKey) : null
  return {
    brandProfileId: text(body.brandProfileId, 80) || null,
    brandName: text(body.brandName, 80, 'ALMA Lifestyle') || 'ALMA Lifestyle',
    recipeKey,
    name,
    sceneSubset: textList(body.sceneSubset, 12, 64),
    modelRoles: modelRoles.length ? modelRoles : ['single'],
    finishTheme: text(body.finishTheme, 48, 'default') || 'default',
    captionTone: text(body.captionTone, 80, 'premium') || 'premium',
    aspectPack: aspectPack.length ? aspectPack : ['4:5'],
    musicVibe: text(body.musicVibe, 48, 'premium') || 'premium',
    qcLevel: oneOf(body.qcLevel, RECIPE_QC_LEVELS, 'strict'),
    spendCeilingBdt: roundMoney(spend),
  }
}

export function assertRecipeMutable(recipe: RecipeLike): void {
  if (recipe.lockedAt) throw new ProjectContractError('recipe_locked')
}

export function nextRecipeVersion(recipe: RecipeLike): number {
  const version = Number(recipe.version ?? 0)
  return Number.isInteger(version) && version > 0 ? version + 1 : 1
}

export function recipeKeyFor(input: Pick<BrandRecipeInput, 'recipeKey' | 'name'>): string {
  return input.recipeKey || slugifyAssetTag(input.name) || 'recipe'
}

export function buildRecipeSnapshot(recipe: {
  id: string
  recipeKey: string
  version: number
  name: string
  sceneSubset: unknown
  modelRoles: unknown
  finishTheme: string
  captionTone: string
  aspectPack: unknown
  musicVibe: string
  qcLevel: string
  spendCeilingBdt: number
}) {
  return {
    id: recipe.id,
    recipeKey: recipe.recipeKey,
    version: recipe.version,
    name: recipe.name,
    sceneSubset: Array.isArray(recipe.sceneSubset) ? recipe.sceneSubset : [],
    modelRoles: Array.isArray(recipe.modelRoles) ? recipe.modelRoles : [],
    finishTheme: recipe.finishTheme,
    captionTone: recipe.captionTone,
    aspectPack: Array.isArray(recipe.aspectPack) ? recipe.aspectPack : [],
    musicVibe: recipe.musicVibe,
    qcLevel: recipe.qcLevel,
    spendCeilingBdt: recipe.spendCeilingBdt,
  }
}
