import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { runAutoStudio, runCreativeStudio, type CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import { READINESS_ERRORS_BN } from '@/lib/creative-studio/single-pipeline'
import { resolveModel } from '@/lib/tryon/model-library'
import { sanitizeStudioError } from '@/lib/creative-studio/studio-errors'
import { studioActionBlockReason } from '@/lib/creative-studio/studio-policy'
import { prisma } from '@/lib/prisma'

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
  // CS13 — xAI Grok Imagine gates
  xai_not_configured: 'XAI_API_KEY সেট করা নেই — Grok Imagine ইঞ্জিন এখন চালানো যাবে না।',
  xai_engine_disabled: 'Grok Imagine বন্ধ আছে — লাইব্রেরি → স্টুডিও সেটিংস থেকে চালু করুন।',
  prompt_required: 'কী বানাতে চান প্রম্পটে লিখে দিন — Generate/Edit মোডে প্রম্পট লাগবেই।',
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
  if (msg.startsWith('engine_mode_unsupported:')) {
    const [, engine, mode] = msg.split(':')
    return `${engine} ইঞ্জিন ${mode} মোডে দরকারি reference গ্রহণ করে না। অন্য সমর্থিত ইঞ্জিন বাছুন — reference বাদ দিয়ে চালানো হবে না।`
  }
  if (msg.startsWith('reference_limit_exceeded:')) {
    return 'এই ইঞ্জিনে বাছাই করা সব reference পাঠানোর জায়গা নেই। কম reference দিন বা অন্য ইঞ্জিন বাছুন।'
  }
  if (
    msg.startsWith('aspect_ratio_unsupported:')
    || msg.startsWith('resolution_unsupported:')
    || msg.startsWith('generation_mode_unsupported:')
    || msg.startsWith('num_images_unsupported:')
  ) {
    return 'এই ইঞ্জিনে বাছাই করা aspect/resolution/mode/count সমর্থিত নয়। দেখানো সমর্থিত option থেকে বাছুন।'
  }
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

  let body: CreativeStudioRunInput & {
    modelId?: string
    auto?: boolean
    includeFamily?: boolean
    includeReel?: boolean
    sourcePendingActionId?: string
  }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.mode === 'image_to_video' && body.sourceImagePath) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = prisma as any
    const sourceId = String(body.sourcePendingActionId ?? '').trim()
    const source = sourceId
      ? await db.agentPendingAction.findUnique({ where: { id: sourceId } })
      : await db.agentPendingAction.findFirst({
        where: {
          payload: { path: ['creativeStudio'], equals: true },
          result: { path: ['storagePath'], equals: body.sourceImagePath },
        },
        orderBy: { createdAt: 'desc' },
      })
    if (sourceId && !source) {
      return Response.json({ error: 'source_not_found', message: 'Creative-টি খুঁজে পাওয়া যায়নি।' }, { status: 404 })
    }
    if (source) {
      const sourceResult = (source.result ?? {}) as Record<string, unknown>
      const sourcePath = String(sourceResult.storagePath ?? '')
      if (sourcePath && sourcePath !== body.sourceImagePath) {
        return Response.json({ error: 'source_mismatch', message: 'Creative এবং file এক নয়। Refresh করুন।' }, { status: 409 })
      }
      const blocked = studioActionBlockReason({
        status: source.status,
        result: sourceResult,
        hasArtifact: Boolean(sourcePath),
      }, 'reel')
      if (blocked) return Response.json({ error: 'qc_failed_blocked', message: blocked }, { status: 409 })
    }
  }

  if (body.auto) {
    try {
      const result = await runAutoStudio({
        productImagePath: body.productImagePath ?? body.sourceImagePath ?? '',
        includeFamily: body.includeFamily,
        includeReel: body.includeReel,
      })
      const imageCount = result.jobs.filter((j) => j.type === 'image_gen').length
      const engine = result.provider === 'xai_imagine'
        ? 'Grok Imagine (xAI)'
        : result.provider === 'fashn' ? 'FASHN (best realism)' : 'Gemini'
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
      return Response.json({ error: sanitizeStudioError(mapRunError(msg)) }, { status: 422 })
    }
  }

  if (body.modelId && !body.modelImagePath) {
    const model = await resolveModel(body.modelId)
    if (model) {
      // CS14 — a built avatar takes over: canonical (or sheet) becomes the
      // person reference; the sheet rides along for xAI identity accuracy.
      const { resolvePersonRef } = await import('@/lib/tryon/model-avatar')
      const ref = await resolvePersonRef(model)
      body.modelImagePath = ref.path
      if (ref.sheetPath) body.avatarSheetPath = ref.sheetPath
    }
  }
  if (body.modelId && body.faceReferencePath === undefined) {
    const model = await resolveModel(body.modelId)
    if (model) body.faceReferencePath = body.modelImagePath ?? model.imagePath
  }

  try {
    const result = await runCreativeStudio(body)
    // CS6 — name the engine that will ACTUALLY run, never a blanket "FASHN".
    const message =
      result.provider === 'xai_imagine'
        ? 'Grok Imagine (xAI) render queued — Gallery-তে ফলাফল দেখুন।'
        : result.provider === 'fal_flux_fill'
        ? 'FLUX Fill precision edit queued — শুধু মাস্ক-করা জায়গা বদলাবে। Gallery-তে দেখুন।'
        : result.provider === 'fal_idm_vton'
        ? 'IDM-VTON (পরীক্ষামূলক) render queued — Gallery-তে ফলাফল দেখুন। ফলাফল যাচাই না করে পাবলিশ করবেন না।'
        : result.provider === 'fal_fashn_v16'
          ? 'Fal FASHN v1.6 render queued — Gallery-তে ফলাফল দেখুন।'
          : result.provider === 'fashn'
            ? 'FASHN render queued — Gallery-তে ফলাফল দেখুন।'
            : `${result.actualModel ?? 'Configured image model'} render queued — সব নির্বাচিত reference বাধ্যতামূলকভাবে পাঠানো হবে।`
    return Response.json({
      ok: true,
      jobs: result.jobs,
      provider: result.provider,
      actualModel: result.actualModel,
      fashnReady: result.fashnReady,
      message,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return Response.json({ error: sanitizeStudioError(mapRunError(msg)) }, { status: 422 })
  }
}
