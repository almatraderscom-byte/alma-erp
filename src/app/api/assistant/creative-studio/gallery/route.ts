import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrls } from '@/agent/lib/storage'
import {
  GALLERY_QC_FAILED_WHERE,
  GALLERY_INTERNAL_ARTIFACT_WHERE,
  GALLERY_TEST_ARTIFACT_WHERE,
  buildGalleryCursorWhere,
  buildGalleryWhere,
  decodeGalleryCursor,
  encodeGalleryCursor,
  isGalleryTestArtifact,
  isGalleryInternalArtifact,
  isGalleryQcFailed,
  normalizeGalleryFilters,
  normalizeGalleryLimit,
} from '@/lib/creative-studio/gallery-query'
import { sanitizeStudioError } from '@/lib/creative-studio/studio-errors'
import { classifyStudioAsset, isStudioAssetPublishable } from '@/lib/creative-studio/studio-policy'
import {
  artifactFieldsFromResult,
  type StudioArtifactDescriptor,
} from '@/lib/creative-studio/artifact-metadata'
import {
  authenticateStudioRequest,
  requireStudioBrandAccess,
  StudioAccessError,
} from '@/lib/creative-studio/studio-access'

export const runtime = 'nodejs'

type Row = {
  id: string
  type: string
  status: string
  summary: string | null
  createdAt: Date
  payload: Record<string, unknown>
  result: Record<string, unknown> | null
}

type Meta = {
  row: Row
  result: Record<string, unknown>
  storagePath: string | null
  brandedPath: string | null
  thumbPath: string | null
  resolutionIntegrity: Record<string, unknown> | null
  variants: StudioArtifactDescriptor[]
  originalVariant: StudioArtifactDescriptor | null
  brandedVariant: StudioArtifactDescriptor | null
}

/** CS10 — one plain-Bangla line summarizing QC + protection metadata. */
function buildQcDetailsBn(result: Record<string, unknown>, payload?: Record<string, unknown>): string | null {
  const parts: string[] = []
  // supplier-photo prep transparency (owner 2026-07-18: the auto split/clean
  // work was invisible — say what actually happened to the reseller photo)
  const chain = payload?.familyChain as { preppedAdultGarmentPath?: string; preppedChildGarmentPath?: string } | undefined
  if (chain?.preppedChildGarmentPath) parts.push('✂️ সাপ্লায়ার ছবি থেকে দুজনের আসল পিস আলাদা')
  else if (chain?.preppedAdultGarmentPath) parts.push('✂️ সাপ্লায়ার ছবি অটো-কাট + টেক্সট-ক্লিন')
  const qc = result.qc as { pass?: boolean; overall?: number; attempts?: number; pipelineMode?: string; coreAxes?: Record<string, number> } | undefined
  if (qc && typeof qc === 'object') {
    const mode = qc.pipelineMode === 'production' ? 'প্রোডাকশন' : qc.pipelineMode === 'preview' ? 'প্রিভিউ' : null
    if (typeof qc.overall === 'number') {
      parts.push(`QC ${qc.pass ? 'পাস' : 'ফেল'} ${qc.overall}/৫${qc.attempts && qc.attempts > 1 ? ` (${qc.attempts} চেষ্টা)` : ''}${mode ? ` · ${mode}` : ''}`)
    }
    const core = qc.coreAxes
    if (core && typeof core === 'object') {
      parts.push(`গার্মেন্ট ${core.garment_fidelity ?? '?'} · মুখ ${core.model_preserved ?? '?'} · হাত/দেহ ${core.anatomy ?? '?'}`)
    }
  }
  if (result.protectedComposite === true) {
    const mc = result.memberCount
    parts.push(`🛡 প্রোটেক্টেড কম্পোজিট${typeof mc === 'number' ? ` · ${mc} জন যাচাই` : ''}`)
  }
  const pd = result.protectedDiff as { maxKeepDelta?: number } | undefined
  if (pd && typeof pd.maxKeepDelta === 'number') {
    parts.push(pd.maxKeepDelta <= 2 ? 'মাস্কের বাইরের পিক্সেল অপরিবর্তিত ✓' : `⚠ সুরক্ষিত পিক্সেলে বদল (${pd.maxKeepDelta})`)
  }
  if (typeof result.maskPreset === 'string' && result.maskPreset) {
    parts.push(`প্রিসেট: ${result.maskPreset}`)
  }
  // CS11 — video QC metrics in plain Bangla
  const vq = result.videoQc as { pass?: boolean; warnings?: string[]; metrics?: { durationSec?: number; loudness?: { inputI?: number } | null }; referenceCheck?: { sameGarment?: boolean; samePerson?: boolean } | null; attempts?: number } | undefined
  if (vq && typeof vq === 'object') {
    const bits: string[] = [`ভিডিও QC ${vq.pass === false ? 'ফ্ল্যাগড' : 'পাস'}`]
    if (vq.metrics?.durationSec) bits.push(`${vq.metrics.durationSec}s`)
    if (vq.metrics?.loudness && typeof vq.metrics.loudness.inputI === 'number') bits.push(`লাউডনেস ${vq.metrics.loudness.inputI.toFixed(1)} LUFS`)
    if (vq.referenceCheck) bits.push(vq.referenceCheck.sameGarment !== false && vq.referenceCheck.samePerson !== false ? 'রেফারেন্স মিল ✓' : '⚠ রেফারেন্স গরমিল')
    if (vq.attempts && vq.attempts > 1) bits.push(`${vq.attempts} চেষ্টা`)
    if (vq.warnings?.length) bits.push(`সতর্কতা: ${vq.warnings.join(',')}`)
    parts.push(bits.join(' · '))
  }
  return parts.length ? parts.join(' — ') : null
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const brandProfileId = req.nextUrl.searchParams.get('brandProfileId')?.trim() ?? ''
  const projectId = req.nextUrl.searchParams.get('projectId')?.trim() ?? ''
  const archivedOnly = req.nextUrl.searchParams.get('archived') === '1'
  const projectAssetId = req.nextUrl.searchParams.get('projectAssetId')?.trim() ?? ''
  const assetVersionId = req.nextUrl.searchParams.get('assetVersionId')?.trim() ?? ''
  const rawReviewSequence = req.nextUrl.searchParams.get('reviewSequence')
  const reviewSequence = rawReviewSequence == null
    ? null
    : Number(rawReviewSequence)
  const exactReviewTarget = Boolean(
    projectAssetId
    || assetVersionId
    || rawReviewSequence != null,
  )
  if (
    exactReviewTarget
    && (
      !brandProfileId
      || !projectId
      || !projectAssetId
      || !assetVersionId
      || !Number.isInteger(reviewSequence)
      || Number(reviewSequence) < 0
    )
  ) {
    return Response.json(
      { error: 'review_asset_snapshot_required' },
      { status: 422 },
    )
  }
  type Canonical = {
    projectAssetId: string
    projectId: string
    brandProfileId: string
    assetVersionId: string | null
    reviewSequence: number
    archived: boolean
  }
  const canonicalByActionId = new Map<string, Canonical>()
  if (brandProfileId || projectId || archivedOnly || exactReviewTarget) {
    if (!brandProfileId) {
      return Response.json({ error: 'brand_scope_required' }, { status: 422 })
    }
    const actor = await authenticateStudioRequest(req)
    if (actor instanceof Response) return actor
    try {
      const access = await requireStudioBrandAccess(actor, brandProfileId)
      const assets = await (prisma as any).creativeProjectAsset.findMany({
        where: {
          ...(projectAssetId ? { id: projectAssetId } : {}),
          ...(reviewSequence != null ? { reviewSequence } : {}),
          project: {
            ownerId: access.ownerId,
            brandProfileId,
            ...(projectId ? { id: projectId } : {}),
          },
        },
        select: {
          id: true,
          projectId: true,
          pendingActionId: true,
          reviewSequence: true,
          project: { select: { brandProfileId: true, archivedAt: true } },
          versions: {
            orderBy: { version: 'desc' },
            select: {
              id: true,
              archiveReceipts: {
                select: { id: true, archivedAt: true, originalDeletedAt: true },
              },
            },
          },
        },
      })
      for (const asset of assets as Array<{
        id: string
        projectId: string
        pendingActionId: string | null
        reviewSequence: number
        project: { brandProfileId: string | null; archivedAt: Date | null }
        versions: Array<{
          id: string
          archiveReceipts: Array<{ id: string }>
        }>
      }>) {
        if (!asset.pendingActionId || asset.project.brandProfileId !== brandProfileId) continue
        if (
          exactReviewTarget
          && asset.versions[0]?.id !== assetVersionId
        ) continue
        // Archive is version-specific and durable. Inspect every version so an
        // older archived original remains discoverable after a newer derivative
        // becomes the current version.
        const archived = Boolean(
          asset.project.archivedAt
          || asset.versions.some((version) => version.archiveReceipts.length > 0),
        )
        if (archivedOnly && !archived) continue
        canonicalByActionId.set(asset.pendingActionId, {
          projectAssetId: asset.id,
          projectId: asset.projectId,
          brandProfileId,
          assetVersionId: asset.versions[0]?.id ?? null,
          reviewSequence: asset.reviewSequence,
          archived,
        })
      }
      if (exactReviewTarget && canonicalByActionId.size !== 1) {
        return Response.json(
          {
            error: 'review_asset_snapshot_changed',
            message: 'The requested review asset/version/sequence is no longer current. Refresh Review before inspecting.',
          },
          { status: 409 },
        )
      }
    } catch (error) {
      const status = error instanceof StudioAccessError ? error.status : 403
      const code = error instanceof StudioAccessError ? error.code : 'forbidden'
      return Response.json({ error: code }, { status })
    }
  } else {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page') ?? 1))
  const limit = normalizeGalleryLimit(req.nextUrl.searchParams.get('limit'))
  const rawCursor = req.nextUrl.searchParams.get('cursor')
  const cursor = decodeGalleryCursor(rawCursor)
  if (rawCursor && !cursor) {
    return Response.json({ error: 'invalid_cursor', message: 'Gallery cursor ঠিক নয়। Refresh করুন।' }, { status: 400 })
  }
  const filters = normalizeGalleryFilters(req.nextUrl.searchParams)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rawWhere = buildGalleryWhere(filters)
  const baseWhere = brandProfileId
    ? {
        AND: [
          rawWhere,
          { id: { in: [...canonicalByActionId.keys()] } },
        ],
      }
    : rawWhere
  // Cursor pagination is stable when new jobs arrive while the owner is
  // scrolling. `page`/skip remains as a backwards-compatible fallback.
  const legacySkip = cursor ? 0 : (page - 1) * limit
  const exclusionPredicates: Array<Record<string, unknown>> = []
  exclusionPredicates.push(GALLERY_INTERNAL_ARTIFACT_WHERE)
  if (!filters.includeTest) exclusionPredicates.push(GALLERY_TEST_ARTIFACT_WHERE)
  if (filters.state === 'ready') exclusionPredicates.push(GALLERY_QC_FAILED_WHERE)

  const totalPromise: Promise<number> = exclusionPredicates.length === 0
    ? db.agentPendingAction.count({ where: baseWhere })
    : Promise.all([
        db.agentPendingAction.count({ where: baseWhere }),
        db.agentPendingAction.count({
          where: { AND: [baseWhere, { OR: exclusionPredicates }] },
        }),
      ]).then(([all, tests]: [number, number]) => Math.max(0, all - tests))

  let visibleRows: Row[] = []
  let exactVisibleTotal: number | null = null
  if (exclusionPredicates.length === 0) {
    const where = cursor
      ? { AND: [baseWhere, buildGalleryCursorWhere(cursor)] }
      : baseWhere
    visibleRows = await db.agentPendingAction.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      skip: legacySkip,
    }) as Row[]
  } else {
    // Do not negate JSON-path comparisons in SQL. Missing keys evaluate to
    // UNKNOWN in PostgreSQL and previously hid every legacy production asset.
    // Scan stable cursor batches and remove only rows with a positive test
    // marker. The separate positive-marker count keeps total/hasMore exact.
    const target = limit + 1
    const batchSize = Math.max(48, Math.min(192, limit * 4))
    let scanCursor = cursor
    let visibleSkipped = 0

    while (visibleRows.length < target) {
      const scanWhere = scanCursor
        ? { AND: [baseWhere, buildGalleryCursorWhere(scanCursor)] }
        : baseWhere
      const batch = await db.agentPendingAction.findMany({
        where: scanWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: batchSize,
      }) as Row[]
      if (batch.length === 0) break

      for (const row of batch) {
        if (isGalleryInternalArtifact(row)) continue
        if (!filters.includeTest && isGalleryTestArtifact(row)) continue
        if (filters.state === 'ready' && isGalleryQcFailed(row)) continue
        if (visibleSkipped < legacySkip) {
          visibleSkipped += 1
          continue
        }
        visibleRows.push(row)
        if (visibleRows.length >= target) break
      }

      if (visibleRows.length >= target) break
      if (batch.length < batchSize) {
        // This scan reached the end, so the positive-marker filter gives us an
        // exact legacy-safe total even though SQL cannot compare chain indices.
        exactVisibleTotal = visibleSkipped + visibleRows.length
        break
      }
      const lastScanned = batch.at(-1)
      if (!lastScanned) break
      scanCursor = { createdAt: lastScanned.createdAt.toISOString(), id: lastScanned.id }
    }
  }

  const countedTotal = await totalPromise
  const total = exactVisibleTotal ?? countedTotal
  const hasMore = visibleRows.length > limit
  const slice = visibleRows.slice(0, limit)

  // Collect every object path across the page, then sign them all in ONE batch
  // request (was one signed-URL round-trip per image → slow gallery).
  const pathsToSign = new Set<string>()
  const meta: Meta[] = slice.map((row: Row): Meta => {
    const result = (row.result ?? {}) as Record<string, unknown>
    const artifactFields = artifactFieldsFromResult(result)
    const storagePath =
      artifactFields.original?.storagePath
      ?? (result.storagePath as string | undefined)
      ?? (result.videoPath as string | undefined)
      ?? null
    const brandedPath =
      artifactFields.branded?.storagePath
      ?? (result.brandedPath as string | undefined)
      ?? null
    // Prefer the (small) thumbnail for the grid; branded thumb if it exists.
    const thumbPath =
      (result.brandedThumbPath as string | undefined)
      ?? (result.thumbPath as string | undefined)
      ?? null
    if (storagePath) pathsToSign.add(storagePath)
    if (brandedPath) pathsToSign.add(brandedPath)
    if (thumbPath) pathsToSign.add(thumbPath)
    // V2 reel cover candidates (video_edit) — signed for the lightbox picker
    for (const c of Array.isArray(result.coverCandidates) ? (result.coverCandidates as string[]) : []) {
      pathsToSign.add(c)
    }
    return {
      row,
      result,
      storagePath,
      brandedPath,
      thumbPath,
      resolutionIntegrity: artifactFields.resolutionIntegrity,
      variants: artifactFields.variants,
      originalVariant: artifactFields.original,
      brandedVariant: artifactFields.branded,
    }
  })

  let signed: Record<string, string> = {}
  try {
    signed = await agentStorageSignedUrls(Array.from(pathsToSign), 3600)
  } catch {
    signed = {}
  }

  const items = meta.map(({
    row,
    result,
    storagePath,
    brandedPath,
    thumbPath,
    resolutionIntegrity,
    variants,
    originalVariant,
    brandedVariant,
  }) => {
    const payload = row.payload ?? {}
    // When the big Supabase original has been archived to Drive and cleaned up,
    // the signed URL is gone — serve the full-res original through the Drive
    // proxy instead (thumbnails stay in Supabase, so the grid is unaffected).
    const driveFiles = (result.driveFiles ?? {}) as Record<string, { fileId?: string }>
    const archivedToDrive = Boolean(result.supabaseDeletedAt)
    const signedPreview = storagePath ? signed[storagePath] ?? null : null
    const driveAvailable = storagePath ? Boolean(driveFiles[storagePath]?.fileId) : false
    const previewUrl =
      signedPreview
      ?? (driveAvailable ? `/api/assistant/creative-studio/drive-file?id=${encodeURIComponent(row.id)}` : null)
    const signedBranded = brandedPath ? signed[brandedPath] ?? null : null
    const brandedDriveAvailable = brandedPath ? Boolean(driveFiles[brandedPath]?.fileId) : false
    const brandedUrl =
      signedBranded
      ?? (brandedDriveAvailable
        ? `/api/assistant/creative-studio/drive-file?id=${encodeURIComponent(row.id)}&path=${encodeURIComponent(brandedPath!)}`
        : null)
    const canonical = canonicalByActionId.get(row.id)
    const visibleStatus = canonical?.archived ? 'archived' : row.status
    const policyInput = {
      status: visibleStatus,
      result,
      hasArtifact: Boolean(storagePath),
    }
    return {
      id: row.id,
      projectAssetId: canonical?.projectAssetId ?? null,
      assetVersionId: canonical?.assetVersionId ?? null,
      reviewSequence: canonical?.reviewSequence ?? null,
      projectId: canonical?.projectId ?? null,
      brandProfileId: canonical?.brandProfileId ?? null,
      type: row.type,
      status: visibleStatus,
      assetState: classifyStudioAsset(policyInput),
      publishable: isStudioAssetPublishable(policyInput),
      summary: row.summary,
      createdAt: row.createdAt.toISOString(),
      mode: payload.studioMode ?? payload.tryOnVariant ?? 'try_on',
      // Truthful lineage: the RESULT'S provider/engine wins over what was
      // requested — never claim the selected engine ran if something else did.
      provider: (result.provider as string | undefined) ?? payload.provider ?? 'gemini',
      familyPreset: payload.familyPreset ?? null,
      // CS6 — engine lineage metadata (fal VTON): engine id, request id, seed,
      // latency and actual cost, straight from the worker's result.
      engine: (result.falEngine as string | undefined) ?? (payload.falEngine as string | undefined)
        ?? (result.xaiEngine as string | undefined) ?? (payload.xaiEngine as string | undefined)
        ?? (result.imageModel as string | undefined) ?? (payload.imageModel as string | undefined) ?? null,
      imageModel: (result.imageModel as string | undefined) ?? (result.xaiModel as string | undefined)
        ?? (payload.imageModel as string | undefined) ?? (payload.xaiModel as string | undefined) ?? null,
      referenceReceipt: result.referenceReceipt && typeof result.referenceReceipt === 'object'
        ? {
            expectedCount: Number((result.referenceReceipt as Record<string, unknown>).expectedCount ?? 0),
            sentCount: Number((result.referenceReceipt as Record<string, unknown>).sentCount ?? 0),
            roles: Array.isArray((result.referenceReceipt as Record<string, unknown>).roles)
              ? ((result.referenceReceipt as Record<string, unknown>).roles as unknown[]).map(String).slice(0, 3)
              : [],
            allRequiredSent: Boolean((result.referenceReceipt as Record<string, unknown>).allRequiredSent),
          }
        : null,
      endpointId: (result.falEndpointId as string | undefined) ?? null,
      requestId: (result.requestId as string | undefined) ?? null,
      seed: (result.seed as number | undefined) ?? null,
      latencyMs: (result.latencyMs as number | undefined) ?? null,
      costUsd: (result.costUsd as number | undefined) ?? null,
      researchOnly: Boolean(result.researchOnly ?? (payload.falEngine === 'fal_idm_vton')),
      qc: (result.qc as Record<string, unknown> | undefined) ?? null,
      // CS10 — plain-Bangla QC/lineage details for the lightbox (CS8/9 follow-ups)
      maskPreset: (result.maskPreset as string | undefined) ?? null,
      protectedDiff: (result.protectedDiff as Record<string, unknown> | undefined) ?? null,
      memberCount: (result.memberCount as number | undefined) ?? null,
      expectedMembers: (result.expectedMembers as number | undefined) ?? null,
      qcDetailsBn: buildQcDetailsBn(result, payload as Record<string, unknown>),
      previewUrl,
      // small image for the grid tile — falls back to the full preview
      thumbUrl: (thumbPath && signed[thumbPath]) || previewUrl,
      // branded (logo + code + hook) variant, when the worker produced one
      brandedUrl,
      resolutionIntegrity,
      variants,
      originalVariant,
      brandedVariant,
      storagePath,
      // true once the original lives only on Google Drive (UI can show a badge)
      archivedToDrive,
      // CS4: model-creator output → lightbox shows "মডেল হিসেবে সেভ"
      modelCreator: (payload.modelCreator as string | undefined) ?? null,
      // Last finishing inputs (hook/code/theme/layout…) — lets the editor reopen
      // pre-filled so the owner adjusts instead of re-typing (native build 67).
      finishParams: (result.finishParams as Record<string, unknown> | undefined) ?? null,
      // V2 reel cover picker options (video_edit only)
      coverOptions: (Array.isArray(result.coverCandidates) ? (result.coverCandidates as string[]) : [])
        .filter((c) => signed[c])
        .map((c) => ({ path: c, url: signed[c] })),
      // Never render provider JSON, request URLs, credentials, stack traces or
      // raw rate-limit payloads to the owner.
      error: result.error == null ? null : sanitizeStudioError(result.error),
    }
  })

  const last = slice.at(-1) as Row | undefined
  const nextCursor = hasMore && last
    ? encodeGalleryCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
    : null

  return Response.json({
    items,
    page,
    total,
    hasMore,
    nextCursor,
    filters,
  })
}
