import { prisma } from '@/lib/prisma'
import {
  PHASE1_VARIANTS,
  PHASE2_FULL_VARIANTS,
  type ContentVariant,
} from '@/lib/content-engine/generate-variants'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const VALID_VARIANTS = new Set<string>(['single', 'father_son', 'mother_son', 'full_family'])

export type ContentEngineConfig = {
  enabled: boolean
  perDay: number
  variants: ContentVariant[]
  draftFirst: boolean
  minDaysBetweenPosts: number
  maxPendingApprovals: number
}

function parseVariants(raw: string | undefined): ContentVariant[] {
  if (!raw?.trim()) return PHASE1_VARIANTS
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter((v): v is ContentVariant => VALID_VARIANTS.has(v))
  return parsed.length ? parsed : PHASE1_VARIANTS
}

function envBool(key: string, defaultValue: boolean): boolean {
  const v = process.env[key]
  if (v === undefined || v === '') return defaultValue
  return v === 'true' || v === '1'
}

function envInt(key: string, defaultValue: number): number {
  const n = Number(process.env[key])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : defaultValue
}

/** Env defaults — KV `content_engine_enabled` overrides when set. */
export function contentEngineConfigFromEnv(): ContentEngineConfig {
  return {
    enabled: envBool('CONTENT_ENGINE_ENABLED', false),
    perDay: envInt('CONTENT_ENGINE_PER_DAY', 1),
    variants: parseVariants(process.env.CONTENT_ENGINE_VARIANTS),
    draftFirst: envBool('CONTENT_ENGINE_QUALITY_DRAFT_FIRST', true),
    minDaysBetweenPosts: envInt('CONTENT_ENGINE_MIN_DAYS_BETWEEN', 2),
    maxPendingApprovals: envInt('CONTENT_ENGINE_MAX_PENDING', 2),
  }
}

export async function getContentEngineConfig(): Promise<ContentEngineConfig> {
  const base = contentEngineConfigFromEnv()
  try {
    const row = await db.agentKvSetting.findUnique({ where: { key: 'content_engine_enabled' } })
    if (row?.value === 'true') return { ...base, enabled: true }
    if (row?.value === 'false') return { ...base, enabled: false }
  } catch {
    // KV unavailable — env only
  }
  return base
}

export async function setContentEngineEnabled(enabled: boolean): Promise<void> {
  await db.agentKvSetting.upsert({
    where: { key: 'content_engine_enabled' },
    update: { value: enabled ? 'true' : 'false' },
    create: { key: 'content_engine_enabled', value: enabled ? 'true' : 'false' },
  })
}

/** Default variant set when product is family-match and env lists only phase-1. */
export function variantsForProduct(
  familyMatch: boolean,
  configured: ContentVariant[],
): ContentVariant[] {
  if (configured.length > 2) return configured
  return familyMatch ? PHASE2_FULL_VARIANTS : configured
}
