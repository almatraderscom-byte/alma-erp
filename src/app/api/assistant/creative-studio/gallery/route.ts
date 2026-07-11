import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { agentStorageSignedUrls } from '@/agent/lib/storage'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const page = Math.max(1, Number(req.nextUrl.searchParams.get('page') ?? 1))
  const limit = Math.min(48, Math.max(12, Number(req.nextUrl.searchParams.get('limit') ?? 24)))
  const skip = (page - 1) * limit

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const rows = await db.agentPendingAction.findMany({
    where: {
      type: { in: ['image_gen', 'video_gen', 'video_edit', 'audio_gen'] },
    },
    orderBy: { createdAt: 'desc' },
    take: limit + 50,
    skip: 0,
  })

  const filtered = rows.filter((r: { payload: unknown }) => {
    const p = r.payload as Record<string, unknown> | null
    return p?.creativeStudio === true
  })

  const slice = filtered.slice(skip, skip + limit)

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
  }

  // Collect every object path across the page, then sign them all in ONE batch
  // request (was one signed-URL round-trip per image → slow gallery).
  const pathsToSign = new Set<string>()
  const meta: Meta[] = slice.map((row: Row): Meta => {
    const result = (row.result ?? {}) as Record<string, unknown>
    const storagePath =
      (result.storagePath as string | undefined)
      ?? (result.videoPath as string | undefined)
      ?? null
    const brandedPath = (result.brandedPath as string | undefined) ?? null
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
    return { row, result, storagePath, brandedPath, thumbPath }
  })

  let signed: Record<string, string> = {}
  try {
    signed = await agentStorageSignedUrls(Array.from(pathsToSign), 3600)
  } catch {
    signed = {}
  }

  const items = meta.map(({ row, result, storagePath, brandedPath, thumbPath }) => {
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
    return {
      id: row.id,
      type: row.type,
      status: row.status,
      summary: row.summary,
      createdAt: row.createdAt.toISOString(),
      mode: payload.studioMode ?? payload.tryOnVariant ?? 'try_on',
      provider: payload.provider ?? 'gemini',
      familyPreset: payload.familyPreset ?? null,
      previewUrl,
      // small image for the grid tile — falls back to the full preview
      thumbUrl: (thumbPath && signed[thumbPath]) || previewUrl,
      // branded (logo + code + hook) variant, when the worker produced one
      brandedUrl: brandedPath ? signed[brandedPath] ?? null : null,
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
      error: result.error ?? null,
    }
  })

  return Response.json({
    items,
    page,
    total: filtered.length,
    hasMore: skip + limit < filtered.length,
  })
}
