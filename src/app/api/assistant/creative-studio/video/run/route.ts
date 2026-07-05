// Phase V1: queue video_edit jobs — one approved pending-action per output
// length, so each reel is its own gallery item and can be retried alone.
// The VPS worker (ffmpeg) does everything; there is no LLM anywhere in this path.
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import {
  getVideoRecipe,
  VIDEO_ASPECTS,
  type VideoAspect,
} from '@/lib/creative-studio/video-recipes'

export const runtime = 'nodejs'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { videoPath?: string; videoName?: string; recipeId?: string; targets?: number[]; aspect?: string }
  try { body = await req.json() } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const videoPath = String(body.videoPath ?? '').trim()
  if (!videoPath.startsWith('studio-video/uploads/') || videoPath.includes('..')) {
    return Response.json({ error: 'আগে একটি ভিডিও আপলোড করে বেছে নিন।' }, { status: 422 })
  }

  const recipe = getVideoRecipe(String(body.recipeId ?? ''))
  if (!recipe) return Response.json({ error: 'invalid_recipe' }, { status: 422 })

  const aspect: VideoAspect = VIDEO_ASPECTS.some((a) => a.id === body.aspect)
    ? (body.aspect as VideoAspect)
    : '9:16'

  const targets = Array.from(new Set((body.targets ?? [recipe.defaultTarget]).map(Number)))
    .filter((t) => recipe.targets.includes(t))
    .sort((a, b) => a - b)
  if (targets.length === 0) return Response.json({ error: 'invalid_targets' }, { status: 422 })

  const videoName = String(body.videoName ?? 'shoot').slice(0, 80)
  const jobs: Array<{ pendingActionId: string; label: string; targetSec: number }> = []
  for (const targetSec of targets) {
    const row = await db.agentPendingAction.create({
      data: {
        conversationId: null,
        type: 'video_edit',
        payload: {
          videoEdit: true,
          creativeStudio: true,
          skipTelegramCard: true,
          studioMode: 'video_edit',
          provider: 'ffmpeg',
          videoPath,
          videoName,
          recipeId: recipe.id,
          targetSec,
          aspect,
        },
        summary: `🎬 ${recipe.labelBn} রিল ${targetSec}s ${aspect} — ${videoName}`,
        costEstimate: 0, // ffmpeg on the VPS — no API spend
        status: 'approved',
      },
    })
    jobs.push({ pendingActionId: row.id as string, label: `${recipe.labelBn} ${targetSec}s`, targetSec })
  }

  return Response.json({
    ok: true,
    jobs,
    message: `${jobs.length}টি রিল তৈরি হচ্ছে (${recipe.labelBn}) — Gallery-তে দেখা যাবে।`,
  })
}
