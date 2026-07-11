/**
 * Family accuracy chain — the assembly line behind one-tap family shots.
 *
 * Instead of asking one Gemini call to invent a child, invent a child-size
 * garment, dress two people AND compose a scene (the old one-shot path that
 * kept failing), each step runs on the tool that is actually accurate at it:
 *
 *   1. adult_tryon   — FASHN tryon-max: saved adult model + product photo
 *   2. child_garment — Gemini: child-size version of the garment (cached per product+role)
 *   3. child_tryon   — FASHN tryon-max: saved child model + child garment
 *   4. pair_merge    — Gemini: composite the two FINISHED photos into one BD scene
 *
 * full_family runs two sub-chains (father+son, mother+daughter) that share one
 * scene, then a final group_merge combines the two pair images.
 *
 * Single-mode FASHN runs get a 2-step chain (adult_tryon → rescene) so the
 * background changes every run and is always authentically Bangladeshi — a raw
 * FASHN try-on keeps the model photo's original background otherwise.
 *
 * Steps are ordinary `agentPendingAction` image_gen jobs (status approved) that
 * the VPS worker already knows how to process; the chain state rides inside
 * each action's payload and `advanceFamilyChain` (called from the job-result
 * callback) queues the next step when one finishes. No new job types, no new
 * tables — caches live in agent_kv_settings like the garment classifier's.
 */
import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { getOrClassifyGarment, normalizeGarmentType, type GarmentAttrs } from '@/lib/tryon/art-director'
import { listModelsByRole, type SavedModel } from '@/lib/tryon/model-library'
import { pickScene, pickSceneWeighted, toSceneRef, type SceneRef } from '@/lib/tryon/scene-pool'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const CHILD_GARMENT_CACHE_PREFIX = 'tryon_child_garment:'
const GROUP_KV_PREFIX = 'family_chain_group:'

export type FamilyChainVariant = 'father_son' | 'mother_son' | 'mother_daughter' | 'father_daughter' | 'couple' | 'full_family'
export type ChainStepKind = 'adult_tryon' | 'child_garment' | 'child_tryon' | 'pair_merge' | 'group_merge' | 'rescene'

const STEP_LABELS_BN: Record<ChainStepKind, string> = {
  adult_tryon: 'বড়দের শট (FASHN)',
  child_garment: 'বাচ্চার গার্মেন্ট তৈরি',
  child_tryon: 'বাচ্চার শট (FASHN)',
  pair_merge: 'এক সিনে বসানো',
  group_merge: 'পুরো ফ্যামিলি একসাথে',
  rescene: 'বাংলাদেশি ব্যাকগ্রাউন্ড',
}

const VARIANT_LABELS_BN: Record<string, string> = {
  single: 'সিঙ্গেল মডেল',
  father_son: 'বাবা + ছেলে',
  mother_son: 'মা + ছেলে',
  mother_daughter: 'মা + মেয়ে',
  father_daughter: 'বাবা + মেয়ে',
  couple: 'কাপল (স্বামী-স্ত্রী)',
  full_family: 'পুরো ফ্যামিলি',
}

export type FamilyChainState = {
  chainId: string
  /** set on full_family sub-chains for final-group coordination */
  groupId?: string
  variant: FamilyChainVariant | 'single'
  scene: SceneRef
  productImagePath: string
  garmentType: string
  fabricNote?: string
  adultRole: 'father' | 'mother'
  childRole?: 'son' | 'daughter' | 'mother'
  adultModelPath: string
  childModelPath?: string
  /** full ordered plan; stepIndex points at the step THIS action performs */
  plan: ChainStepKind[]
  stepIndex: number
  /** artifacts accumulated as steps complete */
  childGarmentPath?: string
  adultImagePath?: string
  childImagePath?: string
  aspectRatio: string
  resolution: string
  generationMode: string
  /** owner's optional free-text direction, carried into generation prompts */
  extraPrompt?: string
  conversationId?: string | null
}

export type ChainJobRef = { pendingActionId: string; label: string; type: 'image_gen' }

function isPanjabiTop(garmentType: string, attrs?: GarmentAttrs): boolean {
  const t = normalizeGarmentType(garmentType)
  if (attrs?.hasContrastBottom) return false
  return ['panjabi', 'short_panjabi', 'kurta', 'koti_set', 'kids_panjabi'].includes(t)
}

const WHITE_PAJAMA_SHORT =
  'Pair the panjabi with plain white loose pajama trousers (how a Bangladeshi man wears it) — never bare legs, jeans, or trousers.'

const IDENTITY_GUARD =
  "Preserve each person's face, age, skin tone, hair and body EXACTLY as in their reference image — no beautification, no face changes. " +
  'Keep every garment pixel-faithful: color, fabric, embroidery pattern, motif placement, collar, buttons and length must not change. ' +
  'AVOID: plastic AI skin, warped hands or fingers, distorted faces, redesigned or simplified embroidery, text artifacts.'

function chainSummary(state: FamilyChainState, step: ChainStepKind): string {
  const variant = VARIANT_LABELS_BN[state.variant] ?? state.variant
  const stepLabel = state.childRole === 'mother' && step === 'child_tryon' ? 'স্ত্রীর শট (FASHN)' : STEP_LABELS_BN[step]
  return `🧬 ${variant} — ধাপ ${state.stepIndex + 1}/${state.plan.length}: ${stepLabel}`
}

// ── Child garment cache (per product image + child role) ──────────────────────

function childGarmentCacheKey(productImagePath: string, childRole: string): string {
  return `${CHILD_GARMENT_CACHE_PREFIX}${childRole}:${productImagePath}`
}

async function readChildGarmentCache(productImagePath: string, childRole: string): Promise<string | null> {
  try {
    const row = await db.agentKvSetting.findUnique({
      where: { key: childGarmentCacheKey(productImagePath, childRole) },
    })
    const v = row?.value?.trim()
    return v || null
  } catch {
    return null
  }
}

export async function writeChildGarmentCache(
  productImagePath: string,
  childRole: string,
  garmentPath: string,
): Promise<void> {
  try {
    const key = childGarmentCacheKey(productImagePath, childRole)
    await db.agentKvSetting.upsert({
      where: { key },
      create: { key, value: garmentPath },
      update: { value: garmentPath },
    })
  } catch (err) {
    console.warn('[family-chain] child garment cache write failed:', err instanceof Error ? err.message : err)
  }
}

// ── Step payload builders ─────────────────────────────────────────────────────

function fashnPosePrompt(pose: string, scene: SceneRef, extra?: string): string {
  return [
    `Pose: ${pose}.`,
    scene.scenePrompt,
    extra ?? '',
    'Photorealistic Bangladeshi fashion photograph, natural light matched to the scene, sharp focus on the garment.',
  ].filter(Boolean).join(' ')
}

function buildStepAction(state: FamilyChainState, step: ChainStepKind): {
  payload: Record<string, unknown>
  summary: string
  costEstimate: number
} {
  const base = {
    familyChain: state,
    creativeStudio: true,
    skipTelegramCard: true,
    studioMode: state.variant === 'single' ? 'try_on' : 'product_to_model',
    familyPreset: state.variant,
    conversationId: state.conversationId ?? null,
  }
  const pajama = isPanjabiTop(state.garmentType) ? WHITE_PAJAMA_SHORT : ''

  switch (step) {
    case 'adult_tryon':
      return {
        payload: {
          ...base,
          provider: 'fashn',
          fashnModel: 'tryon-max',
          fashnInputs: { model_image: state.adultModelPath, product_image: state.productImagePath },
          fashnOptions: {
            prompt: fashnPosePrompt(state.scene.adultPose, state.scene, [pajama, state.extraPrompt].filter(Boolean).join(' ')),
            resolution: state.resolution,
            generationMode: state.generationMode,
            numImages: 1,
            outputFormat: 'png',
          },
          aspectRatio: state.aspectRatio,
        },
        summary: chainSummary(state, step),
        costEstimate: 0.25,
      }

    case 'child_garment': {
      const childWord = state.childRole === 'daughter' ? "girl's (age 5–9)" : "boy's (age 7–11)"
      return {
        payload: {
          ...base,
          creativeStudio: false, // internal artifact — keep the gallery clean
          chainInternal: true,
          prompt: [
            'TASK: e-commerce product photography conversion for a matching family clothing set.',
            `Image 1 shows a garment in ADULT size. Produce a clean PRODUCT PHOTO of the exact same garment tailored as a ${childWord} size:`,
            'identical fabric, identical color, identical embroidery/motif pattern and placement (scaled proportionally), same collar, placket, buttons and cut — adapted only to child proportions.',
            'Present it ghost-mannequin style or neatly displayed on a plain light background. NO person, NO mannequin visible, NO text.',
            state.fabricNote ?? '',
            'The design must remain visually IDENTICAL to Image 1 — it is the child piece of the same matching set. Do not redesign, simplify, or add anything.',
          ].filter(Boolean).join(' '),
          quality: 'pro',
          referenceImageId: state.productImagePath,
          aspectRatio: '4:5',
          imageSize: '2K',
        },
        summary: chainSummary(state, step),
        costEstimate: 0.2,
      }
    }

    case 'child_tryon':
      return {
        payload: {
          ...base,
          provider: 'fashn',
          fashnModel: 'tryon-max',
          fashnInputs: { model_image: state.childModelPath, product_image: state.childGarmentPath },
          fashnOptions: {
            prompt: fashnPosePrompt(
              state.scene.childPose,
              state.scene,
              state.childRole === 'mother'
              ? 'Natural adult proportions; the garment is her piece of the matching couple set.'
              : 'Natural child proportions for the age shown in the model photo; garment sized correctly for the child.',
            ),
            resolution: state.resolution,
            generationMode: state.generationMode,
            numImages: 1,
            outputFormat: 'png',
          },
          aspectRatio: state.aspectRatio,
        },
        summary: chainSummary(state, step),
        costEstimate: 0.25,
      }

    case 'pair_merge':
      return {
        payload: {
          ...base,
          prompt: [
            'TASK: combine two finished fashion photos into ONE cohesive photograph.',
            state.childRole === 'mother'
              ? 'Image 1 = the husband, Image 2 = the wife. Recreate BOTH adults together in a single natural couple scene.'
              : 'Image 1 = person A (adult), Image 2 = person B (child). Recreate BOTH people together in a single scene.',
            IDENTITY_GUARD,
            `SCENE — ${state.scene.scenePrompt}`,
            `POSE — ${state.scene.pairPose}.`,
            state.childRole === 'mother'
              ? 'One consistent light source and color grade across both people, natural contact shadows, natural relative heights for a couple.'
              : 'One consistent light source and color grade across both people, natural contact shadows, correct relative height between the adult and the child.',
            'They wear the SAME matching family collection — the shared motif/color must read clearly as a coordinated set.',
            'Photorealistic professional Bangladeshi family fashion photograph, e-commerce ready.',
            state.extraPrompt ?? '',
          ].filter(Boolean).join(' '),
          quality: 'pro',
          referenceImageId: state.adultImagePath,
          secondReferenceImageId: state.childImagePath,
          aspectRatio: state.aspectRatio,
          imageSize: '2K',
          familyMerge: true,
        },
        summary: chainSummary(state, step),
        costEstimate: 0.25,
      }

    case 'group_merge':
      // referenceImageId/secondReferenceImageId are injected by the group logic.
      return {
        payload: {
          ...base,
          prompt: [
            'TASK: combine two finished family photos into ONE full-family photograph.',
            'Image 1 shows a father and son; Image 2 shows a mother and daughter. Recreate ALL FOUR people together in a single scene.',
            IDENTITY_GUARD,
            `SCENE — ${state.scene.scenePrompt}`,
            `POSE — ${state.scene.groupPose}.`,
            'One consistent light source and color grade across everyone, natural contact shadows, correct relative heights.',
            'All four wear the SAME matching family collection — the coordinated set must read clearly.',
            'Photorealistic professional Bangladeshi family fashion photograph, e-commerce ready.',
            state.extraPrompt ?? '',
          ].filter(Boolean).join(' '),
          quality: 'pro',
          aspectRatio: state.aspectRatio,
          imageSize: '2K',
          familyMerge: true,
        },
        summary: chainSummary(state, step),
        costEstimate: 0.3,
      }

    case 'rescene':
      return {
        payload: {
          ...base,
          prompt: [
            'TASK: replace ONLY the background of this finished fashion photo.',
            'Keep the person and the garment EXACTLY as shown — face, pose, body, fabric, embroidery, colors all pixel-faithful. Do not re-render or "improve" the person.',
            `NEW BACKGROUND — ${state.scene.scenePrompt}`,
            'Re-light globally so the person sits naturally in the new scene (matching light direction and warmth), with believable ground contact/shadow.',
            'Photorealistic, e-commerce ready.',
          ].join(' '),
          quality: 'pro',
          referenceImageId: state.adultImagePath,
          aspectRatio: state.aspectRatio,
          imageSize: '2K',
        },
        summary: chainSummary(state, step),
        costEstimate: 0.2,
      }
  }
}

async function createStepAction(state: FamilyChainState, step: ChainStepKind): Promise<string> {
  const { payload, summary, costEstimate } = buildStepAction(state, step)
  const row = await db.agentPendingAction.create({
    data: {
      conversationId: state.conversationId ?? null,
      type: 'image_gen',
      payload,
      summary,
      costEstimate,
      status: 'approved',
    },
  })
  return row.id as string
}

// ── Chain start ───────────────────────────────────────────────────────────────

const VARIANT_ROLES: Record<FamilyChainVariant, { adult: 'father' | 'mother'; child: 'son' | 'daughter' | 'mother' }> = {
  father_son: { adult: 'father', child: 'son' },
  mother_son: { adult: 'mother', child: 'son' },
  mother_daughter: { adult: 'mother', child: 'daughter' },
  father_daughter: { adult: 'father', child: 'daughter' },
  // couple = two ADULTS: the "child" slot carries the wife, who wears the
  // adult product directly — no child-garment step, no cache.
  couple: { adult: 'father', child: 'mother' },
  full_family: { adult: 'father', child: 'son' }, // resolved per sub-chain
}

export type StartFamilyChainInput = {
  variant: FamilyChainVariant
  productImagePath: string
  aspectRatio?: string
  resolution?: string
  generationMode?: string
  extraPrompt?: string
  conversationId?: string | null
}

export class FamilyChainModelError extends Error {
  missingRoles: string[]
  constructor(missingRoles: string[]) {
    super(`missing_models:${missingRoles.join(',')}`)
    this.missingRoles = missingRoles
  }
}

/** Roles a variant needs, beyond what pairs it can gracefully drop. */
function requiredRoles(variant: FamilyChainVariant): Array<'father' | 'mother' | 'son' | 'daughter'> {
  if (variant === 'father_son') return ['father', 'son']
  if (variant === 'mother_son') return ['mother', 'son']
  if (variant === 'mother_daughter') return ['mother', 'daughter']
  if (variant === 'father_daughter') return ['father', 'daughter']
  if (variant === 'couple') return ['father', 'mother']
  return ['father', 'mother', 'son', 'daughter']
}

async function startPairChain(opts: {
  variant: Exclude<FamilyChainVariant, 'full_family'>
  productImagePath: string
  scene: SceneRef
  models: Partial<Record<string, SavedModel>>
  attrs: GarmentAttrs
  groupId?: string
  aspectRatio: string
  resolution: string
  generationMode: string
  extraPrompt?: string
  conversationId?: string | null
}): Promise<ChainJobRef> {
  const roles = VARIANT_ROLES[opts.variant]
  const adult = opts.models[roles.adult]!
  const child = opts.models[roles.child]!

  // couple: the wife wears the ADULT product as-is — skip the child-garment
  // generation entirely and feed the product straight into her FASHN try-on.
  const isCouple = opts.variant === 'couple'
  const cachedGarment = isCouple
    ? opts.productImagePath
    : await readChildGarmentCache(opts.productImagePath, roles.child)
  const plan: ChainStepKind[] = cachedGarment
    ? ['adult_tryon', 'child_tryon', 'pair_merge']
    : ['adult_tryon', 'child_garment', 'child_tryon', 'pair_merge']

  const state: FamilyChainState = {
    chainId: randomUUID(),
    groupId: opts.groupId,
    variant: opts.variant,
    scene: opts.scene,
    productImagePath: opts.productImagePath,
    garmentType: opts.attrs.garmentType,
    fabricNote: opts.attrs.fabricGuess ? `Garment fabric: ${opts.attrs.fabricGuess}.` : undefined,
    adultRole: roles.adult,
    childRole: roles.child,
    adultModelPath: adult.imagePath,
    childModelPath: child.imagePath,
    childGarmentPath: cachedGarment ?? undefined,
    plan,
    stepIndex: 0,
    extraPrompt: opts.extraPrompt,
    aspectRatio: opts.aspectRatio,
    resolution: opts.resolution,
    generationMode: opts.generationMode,
    conversationId: opts.conversationId ?? null,
  }

  const id = await createStepAction(state, plan[0])
  return { pendingActionId: id, label: VARIANT_LABELS_BN[opts.variant], type: 'image_gen' }
}

/**
 * Start the assembly line for a family variant. Throws FamilyChainModelError
 * when a required saved model (e.g. son/daughter) is missing — callers surface
 * a clear Bangla message telling the owner to add it in the Models tab.
 * Note: deliberately does NOT fall back to the default adult model for a child
 * role (the old silent-fallback produced adults where children belonged).
 */
export async function startFamilyChain(input: StartFamilyChainInput): Promise<{
  jobs: ChainJobRef[]
  sceneLabel: string
}> {
  const productImagePath = input.productImagePath?.trim()
  if (!productImagePath) throw new Error('product_image_required')

  const models = await listModelsByRole()
  const missing = requiredRoles(input.variant).filter((r) => !models[r])
  if (missing.length) throw new FamilyChainModelError(missing)

  // CS4: owner's ভালো/বাদ feedback weights the scene pool (deterministic)
  const { readSceneWeights } = await import('@/lib/creative-studio/taste')
  const picked = pickSceneWeighted(await readSceneWeights())
  const scene = toSceneRef(picked)
  const attrs = await getOrClassifyGarment(productImagePath)
  const common = {
    productImagePath,
    scene,
    models: models as Partial<Record<string, SavedModel>>,
    attrs,
    aspectRatio: input.aspectRatio ?? '4:5',
    resolution: input.resolution ?? '2k',
    generationMode: input.generationMode ?? 'quality',
    extraPrompt: input.extraPrompt,
    conversationId: input.conversationId ?? null,
  }

  if (input.variant === 'full_family') {
    const groupId = randomUUID()
    const [a, b] = await Promise.all([
      startPairChain({ ...common, variant: 'father_son', groupId }),
      startPairChain({ ...common, variant: 'mother_daughter', groupId }),
    ])
    return { jobs: [a, b], sceneLabel: picked.scene.label }
  }

  const job = await startPairChain({ ...common, variant: input.variant })
  return { jobs: [job], sceneLabel: picked.scene.label }
}

/** 2-step chain for a single FASHN try-on: accurate garment first, then a
 * Bangladeshi background swap so no two runs look the same. */
export async function startSingleRescueChain(opts: {
  productImagePath: string
  modelImagePath: string
  aspectRatio?: string
  resolution?: string
  generationMode?: string
  extraPrompt?: string
  conversationId?: string | null
}): Promise<ChainJobRef> {
  const picked = pickScene()
  const scene = toSceneRef(picked)
  const attrs = await getOrClassifyGarment(opts.productImagePath)

  const state: FamilyChainState = {
    chainId: randomUUID(),
    variant: 'single',
    scene,
    productImagePath: opts.productImagePath,
    garmentType: attrs.garmentType,
    fabricNote: attrs.fabricGuess ? `Garment fabric: ${attrs.fabricGuess}.` : undefined,
    adultRole: 'father',
    adultModelPath: opts.modelImagePath,
    plan: ['adult_tryon', 'rescene'],
    stepIndex: 0,
    extraPrompt: opts.extraPrompt,
    aspectRatio: opts.aspectRatio ?? '4:5',
    resolution: opts.resolution ?? '2k',
    generationMode: opts.generationMode ?? 'balanced',
    conversationId: opts.conversationId ?? null,
  }

  const id = await createStepAction(state, 'adult_tryon')
  return { pendingActionId: id, label: VARIANT_LABELS_BN.single, type: 'image_gen' }
}

// ── Chain advance (called from job-result on success) ─────────────────────────

function parseChainState(payload: unknown): FamilyChainState | null {
  if (!payload || typeof payload !== 'object') return null
  const fc = (payload as Record<string, unknown>).familyChain
  if (!fc || typeof fc !== 'object') return null
  const s = fc as FamilyChainState
  if (!s.chainId || !Array.isArray(s.plan) || typeof s.stepIndex !== 'number') return null
  return s
}

async function recordGroupPair(groupId: string, variant: string, pairPath: string): Promise<void> {
  const key = `${GROUP_KV_PREFIX}${groupId}:${variant}`
  await db.agentKvSetting.upsert({
    where: { key },
    create: { key, value: pairPath },
    update: { value: pairPath },
  })
}

async function tryStartGroupMerge(state: FamilyChainState): Promise<string | null> {
  const groupId = state.groupId!
  const [a, b] = await Promise.all([
    db.agentKvSetting.findUnique({ where: { key: `${GROUP_KV_PREFIX}${groupId}:father_son` } }),
    db.agentKvSetting.findUnique({ where: { key: `${GROUP_KV_PREFIX}${groupId}:mother_daughter` } }),
  ])
  const pair1 = a?.value?.trim()
  const pair2 = b?.value?.trim()
  if (!pair1 || !pair2) return null

  // Atomic once-only guard: kv key has a unique constraint, second creator throws.
  try {
    await db.agentKvSetting.create({
      data: { key: `${GROUP_KV_PREFIX}${groupId}:merged`, value: new Date().toISOString() },
    })
  } catch {
    return null
  }

  const mergeState: FamilyChainState = {
    ...state,
    chainId: randomUUID(),
    variant: 'full_family',
    plan: ['group_merge'],
    stepIndex: 0,
  }
  const { payload, summary, costEstimate } = buildStepAction(mergeState, 'group_merge')
  payload.referenceImageId = pair1
  payload.secondReferenceImageId = pair2
  const row = await db.agentPendingAction.create({
    data: {
      conversationId: state.conversationId ?? null,
      type: 'image_gen',
      payload,
      summary,
      costEstimate,
      status: 'approved',
    },
  })
  return row.id as string
}

/**
 * Advance a chain after one step succeeded. Returns the next action id (or
 * null when the chain is complete). Never throws — a chain must not break the
 * worker's job-result callback.
 */
export async function advanceFamilyChain(
  action: { id: string; payload: unknown },
  resultStoragePath: string | undefined,
): Promise<string | null> {
  try {
    const state = parseChainState(action.payload)
    if (!state) return null
    const step = state.plan[state.stepIndex]
    if (!step) return null
    const storagePath = resultStoragePath?.trim()
    if (!storagePath) return null

    // Record this step's artifact.
    const next: FamilyChainState = { ...state }
    if (step === 'adult_tryon') next.adultImagePath = storagePath
    if (step === 'child_garment') {
      next.childGarmentPath = storagePath
      if (state.childRole && state.childRole !== 'mother') await writeChildGarmentCache(state.productImagePath, state.childRole, storagePath)
    }
    if (step === 'child_tryon') next.childImagePath = storagePath

    // Pair finished → either done, or hand off to the full-family group merge.
    if (step === 'pair_merge') {
      if (state.groupId && state.variant !== 'full_family') {
        await recordGroupPair(state.groupId, state.variant, storagePath)
        return tryStartGroupMerge(state)
      }
      return null
    }
    if (step === 'group_merge' || step === 'rescene') return null

    const nextIndex = state.stepIndex + 1
    const nextStep = state.plan[nextIndex]
    if (!nextStep) return null
    next.stepIndex = nextIndex
    return await createStepAction(next, nextStep)
  } catch (err) {
    console.error('[family-chain] advance failed:', err instanceof Error ? err.message : err)
    return null
  }
}

// ── Chain-wide progress (for the studio job tracker) ──────────────────────────

export type ChainProgress = {
  isChain: true
  variantLabel: string
  sceneId: string
  step: number
  totalSteps: number
  stepLabel: string
  /** chain-wide status: running | failed | done */
  chainStatus: 'running' | 'failed' | 'done'
  /** latest action in the chain (for preview when done) */
  latestActionId: string
  latestStoragePath: string | null
}

/**
 * Resolve the chain-wide progress for ANY action belonging to a chain, by
 * finding the newest action carrying the same chainId. Lets the existing UI
 * poll its first job id and still see the whole assembly line.
 */
export async function getChainProgress(action: {
  id: string
  status: string
  payload: unknown
  result: unknown
}): Promise<ChainProgress | null> {
  const state = parseChainState(action.payload)
  if (!state) return null

  // Newest sibling in this chain (payload JSON contains the chainId string).
  const rows = await db.agentPendingAction.findMany({
    where: { type: 'image_gen', createdAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, status: true, payload: true, result: true, createdAt: true },
  })
  type RowT = { id: string; status: string; payload: unknown; result: unknown }
  const siblings = (rows as RowT[]).filter((r) => parseChainState(r.payload)?.chainId === state.chainId)
  const latest = siblings[0] ?? action

  const latestState = parseChainState(latest.payload) ?? state
  const step = latestState.plan[latestState.stepIndex]
  const isLastStep = latestState.stepIndex >= latestState.plan.length - 1
  const result = (latest.result ?? {}) as Record<string, unknown>
  const storagePath = typeof result.storagePath === 'string' ? result.storagePath : null

  let chainStatus: ChainProgress['chainStatus'] = 'running'
  if (latest.status === 'failed') chainStatus = 'failed'
  else if (latest.status === 'executed' && isLastStep) chainStatus = 'done'

  return {
    isChain: true,
    variantLabel: VARIANT_LABELS_BN[latestState.variant] ?? latestState.variant,
    sceneId: latestState.scene?.sceneId ?? '',
    step: latestState.stepIndex + 1,
    totalSteps: latestState.plan.length,
    stepLabel: step ? STEP_LABELS_BN[step] : '',
    chainStatus,
    latestActionId: latest.id,
    latestStoragePath: storagePath,
  }
}
