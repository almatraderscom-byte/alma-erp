import { type NextRequest } from 'next/server'
import { runAutoStudio, runCreativeStudio, type CreativeStudioRunInput } from '@/lib/creative-studio/create-run'
import { READINESS_ERRORS_BN } from '@/lib/creative-studio/single-pipeline'
import { resolveModel } from '@/lib/tryon/model-library'
import { sanitizeStudioError } from '@/lib/creative-studio/studio-errors'
import { prisma } from '@/lib/prisma'
import {
  assertStudioSpendAllowed,
  authenticateStudioRequest,
  StudioAccessError,
  type StudioActor,
} from '@/lib/creative-studio/studio-access'
import {
  assertStudioRunConfirmation,
  issueStudioRunEstimate,
  StudioRunAuthorizationError,
} from '@/lib/creative-studio/studio-run-authorization'
import { buildStudioRunPlan } from '@/lib/creative-studio/studio-run-plan'
import {
  resolveScopedStudioRun,
  type ScopedStudioRunRequest,
} from '@/agent/lib/creative-studio/studio-run-scope'
import { withStudioRunExecutionContext } from '@/lib/creative-studio/studio-run-context'
import { executeStudioRunConfirmation } from '@/lib/creative-studio/studio-run-confirmation'
import {
  validateScopedStudioVideoSourceReady,
} from '@/lib/creative-studio/studio-source-readiness'
import { attachProjectAsset } from '@/lib/creative-studio/project-service'

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
  kids_product_requires_child_model: 'এইটি Kids product। Son বা Daughter role-এর saved child model বাছুন—adult model দিয়ে paid generation block করা হয়েছে।',
  kids_product_requires_labeled_child_model: 'এইটি Kids product। আগে model-টিকে Son বা Daughter role দিয়ে save করুন—ভুল বয়সের model-এ paid generation block করা হয়েছে।',
  product_reference_unclassified: 'Product reference থেকে একক garment নির্ভরযোগ্যভাবে শনাক্ত করা যায়নি। পরিষ্কার, পুরো garment দেখা যায় এমন product photo upload করুন—কোনো paid generation চালানো হয়নি।',
  family_product_requires_role_crop: 'এই Product ছবিতে একাধিক family garment আছে। Single model-এর জন্য যে role-এর পোশাক দরকার (যেমন Son), সেটার পরিষ্কার crop Product source হিসেবে upload করুন—ভুল garment-এ paid generation block করা হয়েছে।',
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
  if (msg.startsWith('resolution_unsupported:')) {
    const [, engine, tier, ...aspectParts] = msg.split(':')
    const aspect = aspectParts.join(':')
    const ratio = aspect ? ` (${aspect})` : ''
    return `${engine} ইঞ্জিনে ${tier?.toUpperCase() ?? 'এই'}${ratio} রেজোলিউশন সমর্থিত নয়। সমর্থিত অপশন বেছে নিন।`
  }
  if (msg.startsWith('aspect_ratio_unsupported:')) {
    const [, engine] = msg.split(':')
    return `${engine} ইঞ্জিনে এই aspect ratio সমর্থিত নয়। তালিকা থেকে সমর্থিত ratio বেছে নিন।`
  }
  if (msg.startsWith('resolution_not_applicable:')) {
    return 'এই ইঞ্জিনে 1K/2K/4K প্রযোজ্য নয়—এটি নেটিভ বা সোর্স ছবির পিক্সেল রাখে।'
  }
  if (msg === 'resolution_required') {
    return 'একটি সমর্থিত image resolution বেছে নিন।'
  }
  if (msg.startsWith('explicit_engine_unavailable:')) {
    return `Selected engine is unavailable or disabled (${msg.split(':')[1]}). Nothing was queued and no fallback was used.`
  }
  if (msg.startsWith('explicit_engine_killed:')) {
    return `Selected engine is disabled by its server kill switch (${msg.split(':')[1]}). Nothing was queued.`
  }
  if (msg.startsWith('explicit_provider_model_mismatch:')) {
    return 'The selected provider does not match the server-configured model. Choose Auto or an exact available provider/model.'
  }
  if (
    msg.startsWith('generation_mode_unsupported:')
    || msg.startsWith('num_images_unsupported:')
  ) {
    return 'এই ইঞ্জিনে বাছাই করা mode/count সমর্থিত নয়। দেখানো সমর্থিত option থেকে বাছুন।'
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

type RunBody = ScopedStudioRunRequest & {
  intent?: 'estimate' | 'confirm'
  receipt?: string
  confirmed?: boolean
  idempotencyKey?: string
  maxCostBdt?: number
}

function runRequestFromBody(body: RunBody): ScopedStudioRunRequest {
  const {
    intent: _intent,
    receipt: _receipt,
    confirmed: _confirmed,
    idempotencyKey: _idempotencyKey,
    maxCostBdt: _maxCostBdt,
    ...request
  } = body
  return request
}

function errorResponse(error: unknown): Response {
  if (error instanceof StudioRunAuthorizationError || error instanceof StudioAccessError) {
    return Response.json({
      error: error.code,
      message: sanitizeStudioError(mapRunError(error.message)),
    }, { status: error.status })
  }
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({
    error: message.split(':')[0] || 'run_rejected',
    message: sanitizeStudioError(mapRunError(message)),
  }, { status: 422 })
}

async function bindQueuedJobsToProject(input: {
  ownerId: string
  projectId: string
  sourceAssetIds: string[]
  jobs: Array<{ pendingActionId: string }>
}): Promise<void> {
  const settled = await Promise.allSettled(input.jobs.map((job) => attachProjectAsset(
    input.ownerId,
    input.projectId,
    {
      pendingActionId: job.pendingActionId,
      sourceAssetIds: input.sourceAssetIds,
    },
  )))
  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      console.error(
        `[creative-studio-run] project asset bind failed for ${input.jobs[index]?.pendingActionId ?? 'unknown'}`,
        result.reason,
      )
    }
  }
}

async function assertSourceReady(body: ScopedStudioRunRequest): Promise<Response | null> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const failure = await validateScopedStudioVideoSourceReady(db, body)
  return failure
    ? Response.json(
        { error: failure.code, message: failure.message },
        { status: failure.status },
      )
    : null
}

export async function POST(req: NextRequest) {
  const authenticated = await authenticateStudioRequest(req)
  if (authenticated instanceof Response) return authenticated
  const actor = authenticated as StudioActor

  let body: RunBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  if (body.intent !== 'estimate' && body.intent !== 'confirm') {
    return Response.json({
      error: 'run_estimate_required',
      message: 'Request an exact server estimate before confirming a paid run.',
    }, { status: 428 })
  }

  try {
    const scoped = await resolveScopedStudioRun(actor, runRequestFromBody(body))
    const effectiveRequest = { ...scoped.request }
    if (effectiveRequest.modelId && !effectiveRequest.modelImagePath) {
      const model = await resolveModel(effectiveRequest.modelId)
      if (!model) throw new StudioAccessError('model_not_found', 404)
      effectiveRequest.modelImagePath = model.imagePath
      if (effectiveRequest.faceReferencePath === undefined) {
        effectiveRequest.faceReferencePath = model.imagePath
      }
    }

    const sourceDenied = await assertSourceReady(effectiveRequest)
    if (sourceDenied) return sourceDenied
    const plan = await buildStudioRunPlan(effectiveRequest)
    assertStudioSpendAllowed(
      scoped.access.role,
      plan.estimateBdt,
      scoped.access.approvalSpendThresholdBdt,
    )

    if (body.intent === 'estimate') {
      const estimate = issueStudioRunEstimate({
        scope: scoped.scope,
        request: effectiveRequest,
        selection: plan.selection,
        estimateBdt: plan.estimateBdt,
        requestedCapBdt: body.maxCostBdt ?? body.requestedCapBdt,
      })
      return Response.json({
        ok: true,
        intent: 'estimate',
        ...estimate,
        estimateUsd: plan.estimateUsd,
        currency: 'BDT',
        confirmationRequired: true,
        providerCallMade: false,
      })
    }

    const claims = assertStudioRunConfirmation({
      receipt: body.receipt,
      request: effectiveRequest,
      scope: scoped.scope,
      selection: plan.selection,
      estimateBdt: plan.estimateBdt,
      confirmation: body.confirmed,
      idempotencyKey: body.idempotencyKey,
      maxCostBdt: body.maxCostBdt,
    })
    const execution = await executeStudioRunConfirmation({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      db: prisma as any,
      reservation: {
        receiptId: claims.receiptId,
        actorUserId: claims.scope.actorUserId,
        idempotencyKey: body.idempotencyKey!,
        requestFingerprint: claims.requestFingerprint,
        selectionFingerprint: claims.selectionFingerprint,
        estimateBdt: claims.estimateBdt,
        maxCostBdt: claims.maxCostBdt,
      },
      // A stale `creating` lease may already own a prefix-deduped subset of
      // these jobs after a process crash. Every constructor upserts by the
      // same receipt/job index and skips already-authorized rows.
      createJobs: () => withStudioRunExecutionContext({
        claims,
        receipt: body.receipt!,
        idempotencyKey: body.idempotencyKey!,
      }, async () => {
        if (effectiveRequest.auto) {
          return runAutoStudio({
            productImagePath: effectiveRequest.productImagePath ?? '',
            modelId: effectiveRequest.modelId ?? '',
            includeFamily: effectiveRequest.includeFamily,
            includeReel: effectiveRequest.includeReel,
            prompt: effectiveRequest.prompt,
            backgroundPrompt: effectiveRequest.backgroundPrompt,
            pipelineMode: effectiveRequest.pipelineMode,
            productName: effectiveRequest.productName,
            pinnedAutoEngine: plan.pinned.autoEngine,
            pinnedGenericImageModel: plan.pinned.genericImageModel,
            pinnedChainVtonEngine: plan.pinned.chainVtonEngine,
          })
        }
        return runCreativeStudio({
          ...(effectiveRequest as CreativeStudioRunInput),
          pinnedGenericImageModel: plan.pinned.genericImageModel,
          pinnedChainVtonEngine: plan.pinned.chainVtonEngine,
        })
      }),
    })
    // Project lineage is a server-owned part of confirmation, not a fragile
    // browser-side follow-up. The client repeats this idempotently for older
    // deployments, while the final worker callback reconciles the chain head.
    await bindQueuedJobsToProject({
      ownerId: scoped.scope.ownerId,
      projectId: scoped.scope.projectId,
      sourceAssetIds: scoped.scope.sourceAssetIds,
      jobs: execution.jobs,
    })
    if (execution.idempotent) {
      return Response.json({
        ok: true,
        idempotent: true,
        jobs: execution.jobs,
        provider: claims.selection.provider,
        actualModel: claims.selection.model,
        estimateBdt: claims.estimateBdt,
        maxCostBdt: claims.maxCostBdt,
        message: 'This confirmed run was already queued. No duplicate jobs were created.',
      })
    }
    const result = execution.result

    const resolvedProvider = claims.selection.provider
    const resolvedModel = claims.selection.model
    const message =
      resolvedProvider === 'xai'
        ? 'Grok Imagine (xAI) render queued — Gallery-তে ফলাফল দেখুন।'
        : resolvedModel === 'fal-ai/flux-pro/v1/fill'
        ? 'FLUX Fill precision edit queued — শুধু মাস্ক-করা জায়গা বদলাবে। Gallery-তে দেখুন।'
        : resolvedModel === 'fal-ai/cat-vton'
        ? 'IDM-VTON (পরীক্ষামূলক) render queued — Gallery-তে ফলাফল দেখুন। ফলাফল যাচাই না করে পাবলিশ করবেন না।'
        : resolvedModel === 'fal-ai/fashn/tryon/v1.6'
          ? 'Fal FASHN v1.6 render queued — Gallery-তে ফলাফল দেখুন।'
          : resolvedProvider === 'fashn'
            ? 'FASHN render queued — Gallery-তে ফলাফল দেখুন।'
            : `${resolvedModel ?? 'Configured image model'} render queued — সব নির্বাচিত reference বাধ্যতামূলকভাবে পাঠানো হবে।`
    return Response.json({
      ok: true,
      idempotent: false,
      jobs: result.jobs,
      provider: resolvedProvider,
      actualModel: resolvedModel,
      selection: claims.selection,
      estimateBdt: claims.estimateBdt,
      maxCostBdt: claims.maxCostBdt,
      message,
    })
  } catch (error) {
    return errorResponse(error)
  }
}
