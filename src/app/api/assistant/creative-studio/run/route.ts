import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { runAutoStudio, runCreativeStudio, type CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import { READINESS_ERRORS_BN } from '@/lib/creative-studio/single-pipeline'
import { resolveModel } from '@/lib/tryon/model-library'
import type { StudioModeId, StudioProvider, FamilyPresetId } from '@/lib/creative-studio/constants'

const AUTO_ERRORS: Record<string, string> = {
  no_default_model: 'প্রথমে Models ট্যাবে একটি মডেল সেভ করুন — তারপর শুধু product upload দিলেই হবে।',
  product_image_required: 'Product ছবি upload করুন।',
  model_image_required: 'মডেলের ছবি দিন — সেভ করা মডেল বাছুন বা নতুন ছবি upload করুন।',
  // CS6 — Fal VTON gates
  fal_not_configured: 'FAL_KEY সেট করা নেই — এই ইঞ্জিন এখন চালানো যাবে না।',
  fal_engine_disabled: 'Fal ইঞ্জিন বন্ধ আছে — লাইব্রেরি → স্টুডিও সেটিংস থেকে "Fal ইঞ্জিন চালু" করুন।',
  idm_vton_disabled: 'IDM-VTON বন্ধ আছে — লাইব্রেরি → স্টুডিও সেটিংস থেকে পরীক্ষামূলক IDM-VTON চালু করুন।',
  // CS7 — FLUX Fill gates
  flux_fill_disabled: 'FLUX Fill বন্ধ আছে — লাইব্রেরি → স্টুডিও সেটিংস থেকে চালু করুন।',
  custom_prompt_required: 'নিজের প্রম্পট প্রিসেটে কী বদলাতে চান লিখে দিন।',
  mask_empty: 'মাস্ক খালি — আগে ব্রাশ দিয়ে এলাকা আঁকুন।',
  mask_covers_everything: 'পুরো ছবি মাস্ক করা যাবে না — যেটুকু বদলাবে সেটুকুই আঁকুন।',
}

const ROLE_BN: Record<string, string> = {
  father: 'বাবা',
  mother: 'মা',
  son: 'ছেলে',
  daughter: 'মেয়ে',
}

/** family accuracy chain needs saved role models — turn missing_models:son,... into a clear Bangla instruction */
function mapRunError(msg: string): string {
  if (msg.startsWith('missing_models:')) {
    const roles = msg.slice('missing_models:'.length).split(',').filter(Boolean)
    const bn = roles.map((r) => ROLE_BN[r] ?? r).join(', ')
    return `ফ্যামিলি শটের জন্য Models ট্যাবে ${bn} মডেল সেভ করুন — একবার সেভ করলেই প্রতিবার একই মুখ আসবে।`
  }
  // CS8 — input readiness gate: clear Bangla corrections BEFORE spending money
  if (msg.startsWith('input_not_ready:')) {
    const codes = msg.slice('input_not_ready:'.length).split(',').filter(Boolean)
    const lines = codes.map((c) => READINESS_ERRORS_BN[c] ?? c)
    return lines.join(' ')
  }
  return AUTO_ERRORS[msg] ?? msg
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
      return Response.json({ error: mapRunError(msg) }, { status: 422 })
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
    // CS6 — name the engine that will ACTUALLY run, never a blanket "FASHN".
    const message =
      result.provider === 'fal_flux_fill'
        ? 'FLUX Fill precision edit queued — শুধু মাস্ক-করা জায়গা বদলাবে। Gallery-তে দেখুন।'
        : result.provider === 'fal_idm_vton'
        ? 'IDM-VTON (পরীক্ষামূলক) render queued — Gallery-তে ফলাফল দেখুন। ফলাফল যাচাই না করে পাবলিশ করবেন না।'
        : result.provider === 'fal_fashn_v16'
          ? 'Fal FASHN v1.6 render queued — Gallery-তে ফলাফল দেখুন।'
          : result.provider === 'fashn'
            ? 'FASHN render queued — Gallery-তে ফলাফল দেখুন।'
            : 'Gemini render queued — FASHN_API_KEY add করলে Pro quality পাবেন।'
    return Response.json({
      ok: true,
      jobs: result.jobs,
      provider: result.provider,
      fashnReady: result.fashnReady,
      message,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: mapRunError(msg) }, { status: 422 })
  }
}
