// CS7 — upload a FLUX Fill mask PNG for a precision edit.
// Contract: white = edit, black = keep; mask dimensions MUST equal the base
// image's (validated here with sharp so a bad mask never reaches a paid call).
import { type NextRequest } from 'next/server'
import { isSystemOwner } from '@/lib/roles'
import { agentStorageDownload, agentStorageUpload } from '@/agent/lib/storage'
import { prisma } from '@/lib/prisma'
import {
  assertMaskDimensionsMatch,
  estimateFluxFillCostUsd,
  maskCoverageRatio,
  validateMaskCoverage,
} from '@/lib/creative-studio/mask-contract'
import {
  assertStudioCapability,
  authenticateStudioRequest,
  studioAccessErrorResponse,
} from '@/lib/creative-studio/studio-access'
import {
  requireStudioResourceContext,
  writeStudioResourceScope,
} from '@/lib/creative-studio/studio-resource-scope'

export const runtime = 'nodejs'
export const maxDuration = 30

const MAX_BYTES = 8 * 1024 * 1024

export async function POST(req: NextRequest) {
  const actor = await authenticateStudioRequest(req)
  if (actor instanceof Response) return actor

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return Response.json({ error: 'invalid_form_data' }, { status: 400 })
  }

  const mask = formData.get('mask') as File | null
  const basePath = formData.get('basePath')?.toString() ?? ''
  const brandProfileId = formData.get('brandProfileId')?.toString() ?? ''
  const projectId = formData.get('projectId')?.toString() ?? ''
  const projectAssetId = formData.get('projectAssetId')?.toString() ?? ''
  const pendingActionId = formData.get('pendingActionId')?.toString() ?? ''
  if (!mask) return Response.json({ error: 'mask_required' }, { status: 400 })
  if (!basePath) return Response.json({ error: 'base_path_required' }, { status: 400 })
  if (mask.size > MAX_BYTES) return Response.json({ error: 'mask_too_large', maxMb: 8 }, { status: 413 })

  let scoped: Awaited<ReturnType<typeof requireStudioResourceContext>> | null = null
  if (brandProfileId || projectId || projectAssetId || pendingActionId) {
    if (!brandProfileId || !projectId || !projectAssetId || !pendingActionId) {
      return Response.json({ error: 'mask_source_scope_required' }, { status: 422 })
    }
    try {
      scoped = await requireStudioResourceContext(actor, { brandProfileId, projectId })
      assertStudioCapability(scoped.access.role, 'draft')
      const asset = await (prisma as any).creativeProjectAsset.findFirst({
        where: {
          id: projectAssetId,
          projectId,
          pendingActionId,
        },
        select: {
          latestStoragePath: true,
          versions: {
            select: { storagePath: true },
          },
        },
      })
      const canonicalPaths = new Set<string>([
        ...(asset?.latestStoragePath ? [String(asset.latestStoragePath)] : []),
        ...((asset?.versions ?? []) as Array<{ storagePath: string | null }>)
          .flatMap((version) => version.storagePath ? [version.storagePath] : []),
      ])
      if (!asset || !canonicalPaths.has(basePath)) {
        return Response.json({ error: 'mask_source_access_forbidden' }, { status: 403 })
      }
    } catch (error) {
      return studioAccessErrorResponse(error, 'creative-mask-upload')
    }
  } else if (!isSystemOwner(actor.erpRole)) {
    return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const sharp = (await import('sharp')).default
    const maskBuf = Buffer.from(await mask.arrayBuffer())
    const baseBuf = await agentStorageDownload(basePath)

    const [maskMeta, baseMeta] = await Promise.all([
      sharp(maskBuf).metadata(),
      sharp(baseBuf).rotate().metadata(), // rotate() = post-EXIF dimensions, what the editor saw
    ])
    const baseW = baseMeta.width ?? 0
    const baseH = baseMeta.height ?? 0
    let maskW = maskMeta.width ?? 0
    let maskH = maskMeta.height ?? 0

    // The editor paints at the ORIGINAL photo's resolution while uploads are
    // downscaled (≤2048, uniform). Same aspect → safely resize the mask onto
    // the stored base's exact dimensions; different aspect = a real mismatch.
    let workingMask = maskBuf
    if ((maskW !== baseW || maskH !== baseH) && baseW && baseH && maskW && maskH) {
      const aspectDelta = Math.abs(maskW / maskH - baseW / baseH)
      if (aspectDelta < 0.005) {
        workingMask = await sharp(maskBuf).resize(baseW, baseH, { fit: 'fill' }).toBuffer()
        maskW = baseW
        maskH = baseH
      }
    }
    assertMaskDimensionsMatch({ width: baseW, height: baseH }, { width: maskW, height: maskH })

    // Normalize to a single-channel PNG (white=edit) and sanity-check coverage.
    const gray = await sharp(workingMask).grayscale().raw().toBuffer()
    const coverage = maskCoverageRatio(new Uint8Array(gray))
    validateMaskCoverage(coverage)

    const pngMask = await sharp(workingMask).grayscale().png().toBuffer()
    const maskPath = `masks/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
    await agentStorageUpload(maskPath, pngMask, 'image/png', { upsert: true })
    if (scoped) {
      await writeStudioResourceScope('mask', maskPath, {
        ownerId: scoped.access.ownerId,
        brandProfileId: scoped.brandProfileId,
        projectId: scoped.projectId,
        createdById: actor.userId,
        sourceAssetIds: [projectAssetId],
        sourcePath: basePath,
      })
    }

    return Response.json({
      maskPath,
      width: maskW,
      height: maskH,
      coveragePct: Math.round(coverage * 1000) / 10,
      estimatedCostUsd: estimateFluxFillCostUsd(maskW, maskH),
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'mask_upload_failed'
    const known = msg.startsWith('mask_') || msg.includes('mask_dimensions')
    return Response.json({ error: known ? msg : 'mask_upload_failed', detail: known ? undefined : msg }, { status: 422 })
  }
}
