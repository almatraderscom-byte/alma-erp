/**
 * CS14 — Model Avatar: a saved model gets up to 10 different-angle photos,
 * from which the worker builds (1) a FREE identity SHEET (deterministic sharp
 * collage — every angle in one image) and (2) an optional Grok CANONICAL
 * portrait (clean neutral studio front shot, one paid call, owner-triggered).
 *
 * Storage: agent_kv_settings `model_avatar:<modelId>` (additive, no migration;
 * the worker reads/writes the same row). Generation-time resolution:
 *  - person reference = canonical ?? sheet ?? the model's original photo
 *  - xAI briefs also attach the sheet as an extra identity reference when a
 *    slot is free (3-reference cap).
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export const MAX_AVATAR_IMAGES = 10
export const AVATAR_KV_PREFIX = 'model_avatar:'

export type ModelAvatar = {
  /** owner-uploaded angle photos (≤10, agent-files paths) */
  imagePaths: string[]
  /** deterministic collage of every angle (free, worker-built) */
  sheetPath?: string
  /** Grok neutral studio portrait (paid, optional) */
  canonicalPath?: string
  builtAt?: string
  /** a build job is queued/running */
  building?: boolean
}

export function avatarKvKey(modelId: string): string {
  return `${AVATAR_KV_PREFIX}${modelId}`
}

export async function readAvatar(modelId: string): Promise<ModelAvatar | null> {
  const row = await db.agentKvSetting.findUnique({ where: { key: avatarKvKey(modelId) } })
  if (!row?.value) return null
  try {
    const parsed = JSON.parse(row.value) as ModelAvatar
    if (!Array.isArray(parsed.imagePaths)) return null
    return parsed
  } catch {
    return null
  }
}

export async function writeAvatar(modelId: string, avatar: ModelAvatar): Promise<void> {
  await db.agentKvSetting.upsert({
    where: { key: avatarKvKey(modelId) },
    update: { value: JSON.stringify(avatar) },
    create: { key: avatarKvKey(modelId), value: JSON.stringify(avatar) },
  })
}

export async function clearAvatar(modelId: string): Promise<void> {
  await db.agentKvSetting.deleteMany({ where: { key: avatarKvKey(modelId) } })
}

export function sanitizeAvatarImagePaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) return []
  return paths
    .map((p) => String(p ?? '').trim())
    .filter((p) => p.length > 0 && !p.includes('..'))
    .slice(0, MAX_AVATAR_IMAGES)
}

export type ResolvedPersonRef = {
  /** best single person reference for any engine */
  path: string
  /** identity sheet to ride along as an EXTRA xAI reference (slot permitting) */
  sheetPath?: string
  /** true when an avatar (not the raw upload) is serving the reference */
  fromAvatar: boolean
}

/**
 * Engine-agnostic person-reference resolution for a saved model. The avatar
 * only takes over once a build has finished (builtAt set) — a half-configured
 * avatar never degrades the existing single-photo flow.
 */
export async function resolvePersonRef(model: { id: string; imagePath: string }): Promise<ResolvedPersonRef> {
  try {
    const avatar = await readAvatar(model.id)
    if (avatar?.builtAt) {
      const path = avatar.canonicalPath ?? avatar.sheetPath
      if (path) {
        return {
          path,
          // the sheet is only an EXTRA when the canonical serves as primary
          sheetPath: avatar.canonicalPath && avatar.sheetPath ? avatar.sheetPath : undefined,
          fromAvatar: true,
        }
      }
    }
  } catch {
    /* avatar lookup must never break generation */
  }
  return { path: model.imagePath, fromAvatar: false }
}
