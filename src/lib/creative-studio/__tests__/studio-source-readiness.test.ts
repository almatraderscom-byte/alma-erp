import { describe, expect, it } from 'vitest'
import {
  validateScopedStudioVideoSourceReady,
} from '@/lib/creative-studio/studio-source-readiness'
import { avatarKvKey } from '@/lib/tryon/model-avatar'

function readinessDb(input: {
  pending?: Record<string, unknown> | null
  modelPath?: string | null
  avatar?: Record<string, unknown> | null
}) {
  return {
    agentPendingAction: {
      findUnique: async () => input.pending ?? null,
    },
    agentBrandModel: {
      findUnique: async () => input.modelPath
        ? { imagePath: input.modelPath }
        : null,
    },
    agentKvSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => {
        expect(where.key).toBe(avatarKvKey('model-1'))
        return input.avatar
          ? { value: JSON.stringify(input.avatar) }
          : null
      },
    },
  }
}

describe('scoped Video Lab source readiness', () => {
  it('accepts durable saved-model and built-avatar paths without a pending action', async () => {
    const db = readinessDb({
      modelPath: 'models/model-1.jpg',
      avatar: {
        imagePaths: ['avatars/angle-1.jpg'],
        canonicalPath: 'avatars/model-1-canonical.jpg',
        sheetPath: 'avatars/model-1-sheet.jpg',
        builtAt: '2026-07-25T12:00:00.000Z',
      },
    })
    for (const sourceImagePath of [
      'models/model-1.jpg',
      'avatars/model-1-canonical.jpg',
      'avatars/model-1-sheet.jpg',
    ]) {
      await expect(validateScopedStudioVideoSourceReady(db, {
        mode: 'image_to_video',
        sourceImagePath,
        modelId: 'model-1',
      })).resolves.toBeNull()
    }
  })

  it('does not let a model id authorize an unrelated private path', async () => {
    const failure = await validateScopedStudioVideoSourceReady(
      readinessDb({ modelPath: 'models/model-1.jpg' }),
      {
        mode: 'image_to_video',
        sourceImagePath: 'private/other-brand.jpg',
        modelId: 'model-1',
      },
    )
    expect(failure).toMatchObject({
      code: 'source_mismatch',
      status: 409,
    })
  })

  it('keeps pending-generation status and artifact readiness authoritative', async () => {
    const missingPending = await validateScopedStudioVideoSourceReady(
      readinessDb({ pending: null }),
      {
        mode: 'image_to_video',
        sourceImagePath: 'generated/source.jpg',
        sourcePendingActionId: 'job-1',
        // A model id must not turn a missing generation into a saved-avatar
        // fallback; the explicit pending lineage remains authoritative.
        modelId: 'model-1',
      },
    )
    expect(missingPending).toMatchObject({
      code: 'source_not_found',
      status: 404,
    })

    const mismatched = await validateScopedStudioVideoSourceReady(
      readinessDb({
        pending: {
          status: 'executed',
          result: { storagePath: 'generated/other.jpg' },
        },
      }),
      {
        mode: 'image_to_video',
        sourceImagePath: 'generated/source.jpg',
        sourcePendingActionId: 'job-1',
      },
    )
    expect(mismatched).toMatchObject({
      code: 'source_mismatch',
      status: 409,
    })

    await expect(validateScopedStudioVideoSourceReady(
      readinessDb({
        pending: {
          status: 'executed',
          result: {
            storagePath: 'generated/source.jpg',
            qc: { pass: true },
          },
        },
      }),
      {
        mode: 'image_to_video',
        sourceImagePath: 'generated/source.jpg',
        sourcePendingActionId: 'job-1',
      },
    )).resolves.toBeNull()
  })
})
