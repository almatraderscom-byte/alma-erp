import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { runAutoStudio, runCreativeStudio, type CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import { resolveModel } from '@/lib/tryon/model-library'
import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'

const AUTO_ERRORS: Record<string, string> = {
  no_default_model: 'প্রথমে Models ট্যাবে একটি মডেল সেভ করুন — তারপর শুধু product upload দিলেই হবে।',
  product_image_required: 'Product ছবি upload করুন।',
}

const RUN_ERRORS: Record<string, string> = {
  product_image_required: 'Product ছবি upload করুন।',
  model_image_required: 'Model ছবি upload করুন।',
  source_image_required: 'Source ছবি upload করুন।',
  fashn_required_not_configured: 'এই mode-টি শুধু FASHN দিয়ে চলে, কিন্তু FASHN এখন configure করা নেই।',
  invalid_mode: 'অজানা mode।',
}

export const runtime = 'nodejs'
export const maxDuration = 60

async function auth(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  return null
}

export async function POST(req: NextRequest) {
  const denied = await auth(req)
  if (denied) return denied

  let body: CreativeStudioRunInput & { modelId?: string; auto?: boolean; includeFamily?: boolean; includeReel?: boolean }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.auto) {
    try {
      const result = await runAutoStudio({
        productImagePath: body.productImagePath ?? body.sourceImagePath ?? '',
        includeFamily: body.includeFamily,
        includeReel: body.includeReel,
      })
      const imageCount = result.jobs.filter((j) => j.type === 'image_gen').length
      const engine = result.provider === 'fashn' ? 'FASHN (best realism)' : 'Gemini'
      const parts = [`✨ ${imageCount}টি ছবি`]
      if (result.reelQueued) parts.push('১টি রিল')
      return Response.json({
        ok: true,
        jobs: result.jobs,
        provider: result.provider,
        reelQueued: result.reelQueued,
        message: `${parts.join(' + ')} তৈরি হচ্ছে · ${engine} · মডেল: ${result.modelName} — Gallery-তে দেখুন।`,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return Response.json({ error: AUTO_ERRORS[msg] ?? msg }, { status: 422 })
    }
  }

  if (body.modelId && !body.modelImagePath) {
    const model = await resolveModel(body.modelId)
    if (model) body.modelImagePath = model.imagePath
  }
  if (body.modelId && body.faceReferencePath === undefined) {
    const model = await resolveModel(body.modelId)
    if (model) body.faceReferencePath = model.imagePath
  }

  try {
    const result = await runCreativeStudio(body)
    return Response.json({
      ok: true,
      jobs: result.jobs,
      provider: result.provider,
      fashnReady: result.fashnReady,
      message:
        result.provider === 'fashn'
          ? 'FASHN render queued — Gallery-তে ফলাফল দেখুন।'
          : 'Gemini render queued — FASHN_API_KEY add করলে Pro quality পাবেন।',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: RUN_ERRORS[msg] ?? msg }, { status: 422 })
  }
}
