import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageDelete, agentStorageSignedUrl } from '@/agent/lib/storage'

export const runtime = 'nodejs'

/**
 * DELETE /api/assistant/creative-studio/jobs/[id]
 * Owner deletes a gallery creative for good: the DB row goes away and the
 * stored files (original / branded / thumbs) are cleaned up best-effort.
 * Guarded to creative-studio rows only — this endpoint can never delete an
 * approval or any other pending action.
 */
export async function DELETE(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.findUnique({ where: { id: params.id } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })

  const payload = (row.payload ?? {}) as Record<string, unknown>
  if (payload.creativeStudio !== true) {
    return Response.json({ error: 'not_a_studio_item' }, { status: 400 })
  }

  const result = (row.result ?? {}) as Record<string, unknown>
  const objectPaths = [
    result.storagePath,
    result.videoPath,
    result.brandedPath,
    result.thumbPath,
    result.brandedThumbPath,
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)
  try {
    await agentStorageDelete(objectPaths)
  } catch (err) {
    console.warn('[studio-jobs] storage cleanup failed (row still deleted):',
      err instanceof Error ? err.message : err)
  }

  await db.agentPendingAction.delete({ where: { id: params.id } })
  return Response.json({ ok: true })
}

export async function GET(req: NextRequest, { params }: { params: { id: string } }) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const row = await db.agentPendingAction.findUnique({ where: { id: params.id } })
  if (!row) return Response.json({ error: 'not_found' }, { status: 404 })

  const payload = (row.payload ?? {}) as Record<string, unknown>
  const result = (row.result ?? {}) as Record<string, unknown>

  // Family-chain job: report CHAIN-WIDE progress so the tracker that polls the
  // first step's id follows the whole assembly line — status stays in-flight
  // until the LAST step lands, with a Bangla step label along the way.
  if (payload.familyChain) {
    try {
      const { getChainProgress } = await import('@/lib/tryon/family-chain')
      const progress = await getChainProgress(row)
      if (progress) {
        let previewUrl: string | null = null
        if (progress.chainStatus === 'done' && progress.latestStoragePath) {
          try {
            previewUrl = await agentStorageSignedUrl(progress.latestStoragePath, 3600)
          } catch {
            previewUrl = null
          }
        }
        return Response.json({
          id: row.id,
          status:
            progress.chainStatus === 'done' ? 'executed'
            : progress.chainStatus === 'failed' ? 'failed'
            : 'approved',
          type: row.type,
          summary: `🧬 ${progress.variantLabel} — ধাপ ${progress.step}/${progress.totalSteps}: ${progress.stepLabel}`,
          mode: payload.studioMode,
          provider: payload.provider ?? 'fashn',
          previewUrl,
          storagePath: progress.chainStatus === 'done' ? progress.latestStoragePath : null,
          chain: {
            step: progress.step,
            totalSteps: progress.totalSteps,
            stepLabel: progress.stepLabel,
            latestActionId: progress.latestActionId,
          },
          error: progress.chainStatus === 'failed' ? (result.error ?? row.error ?? 'chain_step_failed') : null,
        })
      }
    } catch (err) {
      console.warn('[studio-jobs] chain progress failed, falling back to raw row:', err)
    }
  }

  // Phase V1 video_edit job: the worker writes step progress into the payload
  // (ধাপ N/M) while ffmpeg works — surface it exactly like the family chain.
  if (payload.videoEdit) {
    const progress = payload._videoProgress as { step?: number; total?: number; labelBn?: string } | undefined
    const vePath = (result.storagePath ?? null) as string | null
    let vePreview: string | null = null
    if (row.status === 'executed' && vePath) {
      try { vePreview = await agentStorageSignedUrl(vePath, 3600) } catch { vePreview = null }
    }
    const stepText = progress?.step
      ? ` — ধাপ ${progress.step}/${progress.total ?? 5}: ${progress.labelBn ?? ''}`
      : ''
    return Response.json({
      id: row.id,
      status: row.status,
      type: row.type,
      summary: row.status === 'executed' || row.status === 'failed' ? row.summary : `${row.summary}${stepText}`,
      mode: payload.studioMode,
      provider: payload.provider ?? 'ffmpeg',
      previewUrl: vePreview,
      storagePath: row.status === 'executed' ? vePath : null,
      videoProgress: progress ?? null,
      error: (result.error ?? row.error ?? null) as string | null,
    })
  }

  const storagePath = (result.storagePath ?? result.videoPath) as string | undefined

  let previewUrl: string | null = null
  if (storagePath) {
    try {
      previewUrl = await agentStorageSignedUrl(storagePath, 3600)
    } catch {
      previewUrl = null
    }
  }

  return Response.json({
    id: row.id,
    status: row.status,
    type: row.type,
    summary: row.summary,
    mode: payload.studioMode,
    provider: payload.provider,
    previewUrl,
    storagePath,
    error: result.error ?? row.error ?? null,
  })
}
