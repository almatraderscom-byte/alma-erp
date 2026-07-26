import { studioActionBlockReason } from '@/lib/creative-studio/studio-policy'
import { avatarKvKey, type ModelAvatar } from '@/lib/tryon/model-avatar'

// The production Prisma client and focused behavioral double both satisfy this
// intentionally narrow read boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type StudioSourceReadinessDb = any

export type StudioSourceReadinessFailure = {
  code: 'source_not_found' | 'source_mismatch' | 'qc_failed_blocked'
  status: 404 | 409
  message: string
}

function parseReadyAvatar(value: unknown): ModelAvatar | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const avatar = JSON.parse(value) as ModelAvatar
    return avatar?.builtAt && Array.isArray(avatar.imagePaths)
      ? avatar
      : null
  } catch {
    return null
  }
}

/**
 * Readiness runs only after `resolveScopedStudioRun` has authenticated the
 * exact brand/project/model or project-asset lineage. Pending generations keep
 * their status/QC gate. A canonical saved model/avatar is already durable and
 * instead proves its source path against the server-owned model/avatar rows.
 */
export async function validateScopedStudioVideoSourceReady(
  db: StudioSourceReadinessDb,
  input: {
    mode?: string
    sourceImagePath?: string
    sourcePendingActionId?: string
    modelId?: string
  },
): Promise<StudioSourceReadinessFailure | null> {
  if (input.mode !== 'image_to_video' || !input.sourceImagePath) return null

  const sourceId = String(input.sourcePendingActionId ?? '').trim()
  if (sourceId) {
    const source = await db.agentPendingAction.findUnique({
      where: { id: sourceId },
    })
    if (!source) {
      return {
        code: 'source_not_found',
        status: 404,
        message: 'The canonical project source could not be found.',
      }
    }
    const sourceResult = (source.result ?? {}) as Record<string, unknown>
    const sourcePath = String(sourceResult.storagePath ?? '')
    if (sourcePath && sourcePath !== input.sourceImagePath) {
      return {
        code: 'source_mismatch',
        status: 409,
        message: 'The selected project asset and file do not match. Refresh and select it again.',
      }
    }
    const blocked = studioActionBlockReason({
      status: source.status,
      result: sourceResult,
      hasArtifact: Boolean(sourcePath),
    }, 'reel')
    return blocked
      ? { code: 'qc_failed_blocked', status: 409, message: blocked }
      : null
  }

  const modelId = String(input.modelId ?? '').trim()
  if (!modelId) {
    return {
      code: 'source_not_found',
      status: 404,
      message: 'The canonical project source could not be found.',
    }
  }
  const [model, avatarRow] = await Promise.all([
    db.agentBrandModel.findUnique({
      where: { id: modelId },
      select: { imagePath: true },
    }),
    db.agentKvSetting.findUnique({
      where: { key: avatarKvKey(modelId) },
      select: { value: true },
    }),
  ])
  if (!model?.imagePath) {
    return {
      code: 'source_not_found',
      status: 404,
      message: 'The scoped saved model could not be found.',
    }
  }
  const avatar = parseReadyAvatar(avatarRow?.value)
  const allowedPaths = new Set([
    String(model.imagePath),
    ...(avatar?.canonicalPath ? [avatar.canonicalPath] : []),
    ...(avatar?.sheetPath ? [avatar.sheetPath] : []),
  ])
  if (!allowedPaths.has(input.sourceImagePath)) {
    return {
      code: 'source_mismatch',
      status: 409,
      message: 'The selected saved identity and source file do not match. Refresh and select it again.',
    }
  }
  return null
}
