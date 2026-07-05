// Phase V3: motion-template Finishing for a rendered reel — the video twin of
// the image finish route. Owner picks templates + types values; the pure
// planner produces a frame-exact plan; the VPS worker renders it with Remotion
// and composites it over the reel.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { buildOverlayPlan, type FinishTemplateInput } from '@/lib/creative-studio/video-finish'
import { VIDEO_ASPECTS } from '@/lib/creative-studio/video-recipes'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { pendingActionId?: string; templates?: FinishTemplateInput }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const sourceId = String(body.pendingActionId ?? '').trim()
  if (!sourceId) return Response.json({ error: 'invalid_input' }, { status: 422 })

  const source = await db.agentPendingAction.findUnique({ where: { id: sourceId } })
  const sourceResult = (source?.result ?? {}) as Record<string, unknown>
  const sourcePath = sourceResult.storagePath as string | undefined
  if (
    !source
    || source.status !== 'executed'
    || !['video_edit', 'video_gen'].includes(source.type)
    || !sourcePath
  ) {
    return Response.json({ error: 'আগে রিলটি তৈরি শেষ হতে দিন।' }, { status: 422 })
  }

  const aspectDef = VIDEO_ASPECTS.find((a) => a.id === sourceResult.aspect) ?? VIDEO_ASPECTS[0]
  const durationSec = Number(sourceResult.durationSec ?? 0) || 15

  let plan
  try {
    plan = buildOverlayPlan({
      durationSec,
      width: aspectDef.width,
      height: aspectDef.height,
      templates: body.templates ?? {},
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json(
      { error: msg === 'no_templates_selected' ? 'অন্তত একটি টেমপ্লেট বাছুন।' : msg },
      { status: 422 },
    )
  }

  // watermark/end card need the brand logo file
  let brandLogoPath: string | null = null
  if (plan.needsLogo) {
    for (const kind of ['logo_transparent', 'logo']) {
      const row = await db.brandAsset.findUnique({ where: { kind } }).catch(() => null)
      if (row?.path) { brandLogoPath = row.path as string; break }
    }
    if (!brandLogoPath) {
      return Response.json(
        { error: 'লোগো টেমপ্লেটের জন্য আগে Finishing ট্যাবে লোগো আপলোড করুন।' },
        { status: 422 },
      )
    }
  }

  const row = await db.agentPendingAction.create({
    data: {
      conversationId: null,
      type: 'video_finish',
      payload: {
        videoEdit: true, // reuse the studio job tracker's ধাপ N/M branch
        creativeStudio: true,
        skipTelegramCard: true,
        studioMode: 'video_finish',
        provider: 'remotion',
        sourceActionId: sourceId,
        sourcePath,
        plan,
        brandLogoPath,
      },
      summary: `🎞️ টেমপ্লেট ফিনিশিং — ${plan.items.map((i) => i.kind).join(', ')}`,
      costEstimate: 0, // Remotion + ffmpeg on the VPS
      status: 'approved',
    },
  })

  return Response.json({
    ok: true,
    pendingActionId: row.id,
    message: 'টেমপ্লেট বসছে — একটু পরে এই রিলেই "টেমপ্লেট সহ" ভার্সন দেখা যাবে।',
  })
}
