/**
 * Hard verification of the family accuracy chain — the full assembly line is
 * simulated end-to-end against an in-memory Prisma double: every step's
 * payload must match what the VPS worker actually consumes (provider/fashn
 * inputs for FASHN steps, referenceImageId(s) for Gemini steps), artifacts
 * must flow step → step, the child-garment cache must be written and reused,
 * and the full-family group must merge exactly once.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── In-memory prisma double ───────────────────────────────────────────────────

type ActionRow = {
  id: string
  dedupeKey?: string
  conversationId: string | null
  type: string
  payload: Record<string, unknown>
  summary: string
  costEstimate: number
  status: string
  result: Record<string, unknown> | null
  createdAt: Date
}

const actions: ActionRow[] = []
const kv = new Map<string, string>()
let idCounter = 0
const recoveryState = vi.hoisted(() => ({ gateCalls: 0 }))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      create: async ({ data }: { data: Omit<ActionRow, 'id' | 'createdAt'> & { result?: Record<string, unknown> } }) => {
        const row: ActionRow = {
          ...data,
          id: `action-${++idCounter}`,
          result: data.result ?? null,
          createdAt: new Date(Date.now() + idCounter), // preserve creation order
        }
        actions.push(row)
        return row
      },
      findMany: async () => [...actions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findUnique: async ({
        where,
      }: {
        where: { id?: string; dedupeKey?: string }
      }) => actions.find((a) =>
        (where.id && a.id === where.id)
        || (where.dedupeKey && a.dedupeKey === where.dedupeKey),
      ) ?? null,
      upsert: async ({
        where,
        create,
      }: {
        where: { dedupeKey: string }
        create: Omit<ActionRow, 'id' | 'createdAt' | 'result'>
      }) => {
        const existing = actions.find((a) => a.dedupeKey === where.dedupeKey)
        if (existing) return existing
        const row: ActionRow = {
          ...create,
          id: `action-${++idCounter}`,
          result: null,
          createdAt: new Date(Date.now() + idCounter),
        }
        actions.push(row)
        return row
      },
    },
    agentKvSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        kv.has(where.key) ? { key: where.key, value: kv.get(where.key) } : null,
      upsert: async ({ where, create }: { where: { key: string }; create: { key: string; value: string } }) => {
        kv.set(where.key, create.value)
        return { key: where.key, value: create.value }
      },
      create: async ({ data }: { data: { key: string; value: string } }) => {
        if (kv.has(data.key)) throw new Error('unique_violation')
        kv.set(data.key, data.value)
        return data
      },
    },
  },
}))

vi.mock('@/lib/creative-studio/studio-run-execution-gate', () => ({
  assertStudioRunExecutionGate: async () => {
    recoveryState.gateCalls += 1
  },
}))

vi.mock('@/lib/tryon/art-director', () => ({
  getOrClassifyGarment: async () => ({
    garmentType: 'panjabi',
    dominantColors: ['maroon'],
    fabricGuess: 'cotton blend',
    embroideryZones: ['collar', 'placket'],
    hasContrastBottom: false,
    suggestedRole: 'father',
    notes: '',
  }),
  normalizeGarmentType: (v?: string | null, fallback?: string) => v ?? fallback ?? 'unknown',
}))

const modelLibrary: Record<string, { id: string; name: string; imagePath: string; isDefault: boolean; role: string }> = {}

vi.mock('@/lib/tryon/model-library', () => ({
  listModelsByRole: async () => ({ ...modelLibrary }),
}))

import {
  startFamilyChain as startFamilyChainAuthorized,
  startSingleRescueChain as startSingleRescueChainAuthorized,
  advanceFamilyChain,
  getChainProgress,
  type FamilyChainState,
} from '@/lib/tryon/family-chain'
import { BD_SCENES, pickScene } from '@/lib/tryon/scene-pool'
import {
  issueStudioRunEstimate,
  verifyStudioRunEstimateReceipt,
} from '@/lib/creative-studio/studio-run-authorization'
import { withStudioRunExecutionContext } from '@/lib/creative-studio/studio-run-context'
import type { StudioReferenceContract } from '@/lib/creative-studio/advanced-image-capabilities'

function issueAuthorizedRun() {
  const estimate = issueStudioRunEstimate({
    scope: {
      actorUserId: 'owner-1',
      ownerId: 'owner-1',
      role: 'owner',
      brandProfileId: 'brand-1',
      projectId: 'project-1',
      productId: 'product-1',
      sourceAssetIds: ['asset-1'],
      familyModelPins: Object.values(modelLibrary).map((model) => ({
        role: model.role as 'father' | 'mother' | 'son' | 'daughter',
        modelId: model.id,
        modelImagePath: model.imagePath,
        sourceImagePath: model.imagePath,
        modelName: model.name,
      })),
    },
    request: { mode: 'product_to_model' },
    selection: {
      mode: 'product_to_model',
      architecture: 'advanced',
      provider: 'gemini',
      model: 'gemini-2.5-flash-image',
      providers: ['google', 'fashn', 'fal'],
      models: ['gemini-2.5-flash-image', 'tryon-max'],
      plan: ['family_chain'],
      paidAttemptLimit: 3,
    },
    estimateBdt: 500,
    requestedCapBdt: 500,
  })
  const claims = verifyStudioRunEstimateReceipt(estimate.receipt, {
    phase: 'execute',
  })
  return { claims, receipt: estimate.receipt }
}

async function withAuthorizedRun<T>(run: () => Promise<T>): Promise<T> {
  const authorized = issueAuthorizedRun()
  return withStudioRunExecutionContext({
    claims: authorized.claims,
    receipt: authorized.receipt,
    idempotencyKey: `family-chain-test:${authorized.claims.receiptId}`,
  }, run)
}

const startFamilyChain = (
  input: Parameters<typeof startFamilyChainAuthorized>[0],
) => withAuthorizedRun(() => startFamilyChainAuthorized(input))

const startSingleRescueChain = (
  input: Parameters<typeof startSingleRescueChainAuthorized>[0],
) => withAuthorizedRun(() => startSingleRescueChainAuthorized(input))

function seedModels(roles: string[]) {
  for (const role of roles) {
    modelLibrary[role] = {
      id: `model-${role}`,
      name: `Model ${role}`,
      imagePath: `models/${role}.jpg`,
      isDefault: role === 'father',
      role,
    }
  }
}

function lastAction(): ActionRow {
  return actions[actions.length - 1]
}

function chainState(row: ActionRow): FamilyChainState {
  return row.payload.familyChain as FamilyChainState
}

/** Simulate the worker finishing a job + the job-result hook advancing the chain. */
async function completeStep(row: ActionRow, storagePath: string, extraResult: Record<string, unknown> = {}): Promise<string | null> {
  row.status = 'executed'
  row.result = { storagePath, ...extraResult }
  return advanceFamilyChain(row, storagePath || undefined)
}


/** Complete the leading garment_prep step with NO usable crops (legacy path). */
async function passPrep(): Promise<ActionRow> {
  const prep = lastAction()
  if (chainState(prep).plan[chainState(prep).stepIndex] !== 'garment_prep') return prep
  const nextId = await completeStep(prep, '', { garmentPrep: true, adultGarmentPath: null, childGarmentPath: null })
  return actions.find((a) => a.id === nextId)!
}

beforeEach(() => {
  process.env.CREATIVE_STUDIO_RUN_CONFIRMATION_SECRET =
    'test-only-studio-run-confirmation-secret'
  actions.length = 0
  kv.clear()
  idCounter = 0
  recoveryState.gateCalls = 0
  for (const k of Object.keys(modelLibrary)) delete modelLibrary[k]
})

describe('scene pool', () => {
  it('every scene is Bangladeshi-flavoured and poses are non-empty', () => {
    expect(BD_SCENES.length).toBeGreaterThanOrEqual(8)
    for (const s of BD_SCENES) expect(s.prompt.toLowerCase()).toMatch(/bangladesh|dhaka|dhanmondi/)
    const p = pickScene()
    expect(p.adultPose).toBeTruthy()
    expect(p.childPose).toBeTruthy()
    expect(p.pairPose).toBeTruthy()
  })
})

describe('startFamilyChain', () => {
  it('consumes the signed family paths even if the global role rows change before construction', async () => {
    seedModels(['father', 'son'])
    const authorized = issueAuthorizedRun()
    modelLibrary.father.imagePath = 'models/reassigned-father.jpg'
    modelLibrary.son.imagePath = 'models/reassigned-son.jpg'

    await withStudioRunExecutionContext({
      claims: authorized.claims,
      receipt: authorized.receipt,
      idempotencyKey: `family-pins:${authorized.claims.receiptId}`,
    }, () => startFamilyChainAuthorized({
      variant: 'father_son',
      productImagePath: 'uploads/panjabi.jpg',
    }))

    const state = chainState(lastAction())
    expect(state.adultModelPath).toBe('models/father.jpg')
    expect(state.childModelPath).toBe('models/son.jpg')
  })

  it('recovers the exact first family step after a crash even when the retry picks another scene', async () => {
    seedModels(['father', 'son'])
    const authorized = issueAuthorizedRun()
    const run = () => withStudioRunExecutionContext({
      claims: authorized.claims,
      receipt: authorized.receipt,
      idempotencyKey: `family-recovery:${authorized.claims.receiptId}`,
    }, () => startFamilyChainAuthorized({
      variant: 'father_son',
      productImagePath: 'uploads/panjabi.jpg',
    }))
    const random = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999999)
    try {
      const first = await run()
      const originalScene = chainState(actions[0]).scene
      const recovered = await run()

      expect(recovered.jobs[0].pendingActionId).toBe(first.jobs[0].pendingActionId)
      expect(actions).toHaveLength(1)
      expect(chainState(actions[0]).scene).toEqual(originalScene)
      expect(recoveryState.gateCalls).toBe(1)
    } finally {
      random.mockRestore()
    }
  })

  it('throws FamilyChainModelError naming missing roles instead of silently using an adult', async () => {
    seedModels(['father'])
    await expect(
      startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' }),
    ).rejects.toMatchObject({ missingRoles: ['son'] })
  })

  it('queues the adult FASHN step with a worker-compatible payload (after prep)', async () => {
    seedModels(['father', 'son'])
    const { jobs } = await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' })
    expect(jobs).toHaveLength(1)

    const row = await passPrep()
    expect(row.status).toBe('approved')
    expect(row.type).toBe('image_gen')
    // exactly what worker/src/index.mjs dispatches on:
    expect(row.payload.provider).toBe('fashn')
    expect(row.payload.fashnModel).toBe('tryon-max')
    expect(row.payload.fashnInputs).toEqual({
      model_image: 'models/father.jpg',
      product_image: 'uploads/panjabi.jpg',
    })
    expect((row.payload.referenceContract as StudioReferenceContract).bindings[0]).toMatchObject({
      source: 'saved_model',
      sourceId: 'model-father',
    })
    const state = chainState(row)
    expect(state.plan).toEqual(['garment_prep', 'adult_tryon', 'child_tryon', 'pair_merge'])
    expect(state.stepIndex).toBe(1)
    // panjabi without contrast bottom → white pajama rule must ride along
    expect(String((row.payload.fashnOptions as Record<string, unknown>).prompt)).toContain('white')
  })

  it('NEVER plans an AI child_garment step — even when a legacy cache entry exists (owner 2026-07-17)', async () => {
    seedModels(['mother', 'daughter'])
    kv.set('tryon_child_garment:daughter:uploads/set.jpg', 'generated/child-set.png')
    await startFamilyChain({ variant: 'mother_daughter', productImagePath: 'uploads/set.jpg' })
    const state = chainState(lastAction())
    expect(state.plan).toEqual(['garment_prep', 'adult_tryon', 'child_tryon', 'pair_merge'])
    // the stale AI garment is ignored — the child will wear the adult garment
    expect(state.childGarmentPath).toBeUndefined()
  })
})

describe('chain advance — father_son end to end', () => {
  it('carries artifacts step to step; child wears the SAME adult garment', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' })
    await passPrep()

    // Step 1: adult FASHN shot done → straight to the child try-on
    let nextId = await completeStep(lastAction(), 'generated/father-shot.png')
    expect(nextId).toBeTruthy()
    let row = lastAction()
    let state = chainState(row)
    expect(state.plan[state.stepIndex]).toBe('child_tryon')
    expect(state.adultImagePath).toBe('generated/father-shot.png')
    // child FASHN try-on dresses the SAVED son model in the ADULT garment —
    // the engine sizes it to the child's body (owner 2026-07-17)
    expect(row.payload.fashnInputs).toEqual({
      model_image: 'models/son.jpg',
      product_image: 'uploads/panjabi.jpg',
    })
    expect((row.payload.referenceContract as StudioReferenceContract).bindings[0]).toMatchObject({
      source: 'saved_model',
      sourceId: 'model-son',
    })

    // Step 2: child shot done
    nextId = await completeStep(row, 'generated/son-shot.png')
    row = lastAction()
    state = chainState(row)
    expect(state.plan[state.stepIndex]).toBe('pair_merge')
    // merge composites the two FINISHED photos — both must be references
    expect(row.payload.referenceImageId).toBe('generated/father-shot.png')
    expect(row.payload.secondReferenceImageId).toBe('generated/son-shot.png')
    expect(String(row.payload.prompt)).toContain('SCENE')

    // Step 4: merge done → chain complete, no further action
    nextId = await completeStep(row, 'generated/family.png')
    expect(nextId).toBeNull()

    // one scene across the whole chain (consistent light/background for the merge)
    const sceneIds = actions.map((a) => chainState(a).scene.sceneId)
    expect(new Set(sceneIds).size).toBe(1)
  })
})

describe('full_family group', () => {
  it('starts two sub-chains and creates the group merge exactly once', async () => {
    seedModels(['father', 'mother', 'son', 'daughter'])
    const { jobs } = await startFamilyChain({ variant: 'full_family', productImagePath: 'uploads/set.jpg' })
    expect(jobs).toHaveLength(2)

    // Drive both sub-chains to their pair_merge (prep yields BOTH real pieces
    // — মা+মেয়ে requires the daughter's own dress since 2026-07-18)
    const drive = async (startIdx: number) => {
      let row = actions[startIdx]
      let guard = 0
      while (chainState(row).plan[chainState(row).stepIndex] !== 'pair_merge' && guard++ < 6) {
        const step = chainState(row).plan[chainState(row).stepIndex]
        const extra = step === 'garment_prep'
          ? { garmentPrep: true, adultGarmentPath: `prepped/${row.id}-p1.png`, childGarmentPath: `prepped/${row.id}-p2.png` }
          : {}
        const nextId = await completeStep(row, step === 'garment_prep' ? '' : `generated/${row.id}.png`, extra)
        row = actions.find((a) => a.id === nextId)!
      }
      return row
    }
    const pairA = await drive(0)
    const pairB = await drive(1)

    // First pair merge completes → group not ready yet
    const afterA = await completeStep(pairA, 'generated/pair-father-son.png')
    expect(afterA).toBeNull()
    // Second pair merge completes → group merge created ONCE
    const afterB = await completeStep(pairB, 'generated/pair-mother-daughter.png')
    expect(afterB).toBeTruthy()
    const merge = actions.find((a) => a.id === afterB)!
    expect(merge.payload.referenceImageId).toBe('generated/pair-father-son.png')
    expect(merge.payload.secondReferenceImageId).toBe('generated/pair-mother-daughter.png')

    // Re-delivering the same completion (worker retry) must NOT spawn a second merge
    const again = await advanceFamilyChain(pairB, 'generated/pair-mother-daughter.png')
    expect(again).toBeNull()
  })
})

describe('single rescene chain', () => {
  it('follows FASHN accuracy with a Bangladeshi background swap', async () => {
    const { pendingActionId } = await startSingleRescueChain({
      productImagePath: 'uploads/panjabi.jpg',
      modelImagePath: 'models/owner.jpg',
      modelRole: 'son',
      backgroundPrompt: 'clean owner-selected warm studio',
    })
    const prep = actions.find((a) => a.id === pendingActionId)!
    expect(prep.payload.provider).toBe('garment_prep')
    const first = await passPrep()
    expect(first.payload.provider).toBe('fashn')

    const nextId = await completeStep(first, 'generated/tryon.png')
    const rescene = actions.find((a) => a.id === nextId)!
    expect(rescene.payload.referenceImageId).toBe('generated/tryon.png')
    expect(rescene.payload.referenceImageIds).toEqual([
      'generated/tryon.png',
      'models/owner.jpg',
      'uploads/panjabi.jpg',
    ])
    expect(rescene.payload.qcSurface).toBe('single_tryon')
    expect(String(rescene.payload.prompt)).toMatch(/background/i)
    expect(String(rescene.payload.prompt)).toContain('clean owner-selected warm studio')
    expect(String(rescene.payload.prompt)).toContain('selected person role is son')
    expect(String(rescene.payload.prompt)).not.toContain('mosque')

    const done = await completeStep(rescene, 'generated/final.png')
    expect(done).toBeNull()
  })

  it('keeps every signed chain image in the isolated preview lane', async () => {
    const previous = process.env.VERCEL_ENV
    process.env.VERCEL_ENV = 'preview'
    try {
      const { pendingActionId } = await startSingleRescueChain({
        productImagePath: 'uploads/panjabi.jpg',
        modelImagePath: 'models/owner.jpg',
      })
      const prep = actions.find((a) => a.id === pendingActionId)!
      expect(prep.status).toBe('preview_approved')
      const first = await passPrep()
      expect(first.status).toBe('preview_approved')
      const nextId = await completeStep(first, 'generated/tryon.png')
      const rescene = actions.find((a) => a.id === nextId)!
      expect(rescene.status).toBe('preview_approved')
    } finally {
      if (previous === undefined) delete process.env.VERCEL_ENV
      else process.env.VERCEL_ENV = previous
    }
  })

  it('carries the selected tier and aspect into the final rescene instead of hard-coding 2K', async () => {
    const { pendingActionId } = await startSingleRescueChain({
      productImagePath: 'uploads/panjabi.jpg',
      modelImagePath: 'models/owner.jpg',
      aspectRatio: '16:9',
      resolution: '4k',
      imageModel: 'gpt-image-2',
    })
    const prep = actions.find((a) => a.id === pendingActionId)!
    expect(prep.payload.provider).toBe('garment_prep')
    const first = await passPrep()
    expect((first.payload.referenceContract as Record<string, unknown>).actualModel).toBe('tryon-max')
    const nextId = await completeStep(first, 'generated/tryon.png')
    const rescene = actions.find((a) => a.id === nextId)!

    expect(rescene.payload.provider).toBe('generic_image')
    expect(rescene.payload.imageModel).toBe('gpt-image-2')
    expect(rescene.payload.aspectRatio).toBe('16:9')
    expect(rescene.payload.imageSize).toBe('4K')
    expect(rescene.payload.requestedResolution).toBe('4k')
    expect(rescene.payload.requestedAspectRatio).toBe('16:9')
    expect((rescene.payload.referenceContract as Record<string, unknown>).actualModel).toBe('gpt-image-2')
    expect((rescene.payload.controlContract as {
      applied: Record<string, unknown>
    }).applied).toMatchObject({
      model: 'gpt-image-2',
      aspectRatio: '16:9',
      resolution: '4k',
    })
  })
})

describe('getChainProgress', () => {
  it('reports chain-wide progress from the first job id', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' })
    const first = lastAction() // garment_prep
    const adult = await passPrep()
    await completeStep(adult, 'generated/father-shot.png')

    const progress = await getChainProgress(first)
    expect(progress).not.toBeNull()
    expect(progress!.chainStatus).toBe('running')
    expect(progress!.step).toBe(3)
    expect(progress!.totalSteps).toBe(4)
  })
})

// ── CS9: protected compositing (no face/garment regeneration) ────────────────

describe('CS9 protected composite chain', () => {
  it('replaces pair_merge with pair_composite carrying a worker-ready payload', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({
      variant: 'father_son',
      productImagePath: 'uploads/panjabi.jpg',
      protectedComposite: true,
    })
    let row = await passPrep()
    expect(chainState(row).plan).toEqual(['garment_prep', 'adult_tryon', 'child_tryon', 'pair_composite'])

    let nextId = await completeStep(row, 'generated/adult.png')
    row = actions.find((a) => a.id === nextId)!
    nextId = await completeStep(row, 'generated/child.png')
    row = actions.find((a) => a.id === nextId)!

    // final step = the protected composite job the worker consumes
    expect(row.payload.provider).toBe('family_composite')
    const composite = row.payload.composite as Record<string, unknown>
    expect(composite.baseImagePath).toBe('generated/adult.png')
    expect(composite.insertImagePath).toBe('generated/child.png')
    expect(composite.insertRole).toBe('son')
    expect(composite.expectedMembers).toBe(2)
    expect(composite.harmonize).toBe(true)

    const done = await completeStep(row, 'generated/family.png')
    expect(done).toBeNull()
  })

  it('couple maps the wife to insertRole mother', async () => {
    seedModels(['father', 'mother'])
    await startFamilyChain({
      variant: 'couple',
      productImagePath: 'uploads/panjabi.jpg',
      protectedComposite: true,
    })
    let row = await passPrep()
    // couple: no child-garment step (wife wears the adult product)
    expect(chainState(row).plan).toEqual(['garment_prep', 'adult_tryon', 'child_tryon', 'pair_composite'])
    let nextId = await completeStep(row, 'generated/husband.png')
    row = actions.find((a) => a.id === nextId)!
    nextId = await completeStep(row, 'generated/wife.png')
    row = actions.find((a) => a.id === nextId)!
    const composite = row.payload.composite as Record<string, unknown>
    expect(composite.insertRole).toBe('mother')
  })

  it('full family: two protected pairs combine via ONE group_composite with pair inserts', async () => {
    seedModels(['father', 'mother', 'son', 'daughter'])
    const { jobs } = await startFamilyChain({
      variant: 'full_family',
      productImagePath: 'uploads/panjabi.jpg',
      protectedComposite: true,
    })
    expect(jobs).toHaveLength(2)

    // run both sub-chains to their pair_composite completion (prep yields
    // both real pieces — the মা+মেয়ে leg needs the daughter's own dress)
    for (const job of jobs) {
      let row = actions.find((a) => a.id === job.pendingActionId)!
      let next = await completeStep(row, '', {
        garmentPrep: true,
        adultGarmentPath: `prepped/${chainState(row).variant}-p1.png`,
        childGarmentPath: `prepped/${chainState(row).variant}-p2.png`,
      })
      while (next) {
        row = actions.find((a) => a.id === next)!
        const step = chainState(row).plan[chainState(row).stepIndex]
        next = await completeStep(row, `generated/${chainState(row).variant}-${step}.png`)
      }
    }

    const groupJobs = actions.filter(
      (a) => (a.payload.composite as Record<string, unknown> | undefined)?.insertRole === 'pair',
    )
    expect(groupJobs).toHaveLength(1) // exactly once
    const composite = groupJobs[0].payload.composite as Record<string, unknown>
    expect(composite.expectedMembers).toBe(4)
    expect(composite.baseImagePath).toBe('generated/father_son-pair_composite.png')
    expect(composite.insertImagePath).toBe('generated/mother_daughter-pair_composite.png')
  })

  it('default (no opt-in) keeps the legacy generative pair_merge', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' })
    expect(chainState(lastAction()).plan).toContain('pair_merge')
    expect(chainState(lastAction()).plan).not.toContain('pair_composite')
  })
})

describe('owner directive 2026-07-17 — chain VTON on Fal', () => {
  it('vtonEngine fal_fashn_v16 → tryon steps carry the CS6 fal adapter payload', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({
      variant: 'father_son',
      productImagePath: 'uploads/panjabi.jpg',
      protectedComposite: true,
      vtonEngine: 'fal_fashn_v16',
    })
    let row = await passPrep()
    // adult step = fal, not direct fashn
    expect(row.payload.provider).toBe('fal')
    expect(row.payload.falEngine).toBe('fal_fashn_v16')
    expect(row.payload.modelImagePath).toBe('models/father.jpg')
    expect(row.payload.productImagePath).toBe('uploads/panjabi.jpg')

    const nextId = await completeStep(row, 'generated/adult.png')
    row = actions.find((a) => a.id === nextId)!
    // child tryon = fal with the SAME adult garment (no AI child garment)
    expect(row.payload.provider).toBe('fal')
    expect(row.payload.productImagePath).toBe('uploads/panjabi.jpg')
    expect(row.payload.modelImagePath).toBe('models/son.jpg')
  })

  it('default (no vtonEngine) keeps legacy direct FASHN payloads', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' })
    const adult = await passPrep()
    expect(adult.payload.provider).toBe('fashn')
    expect(adult.payload.fashnModel).toBe('tryon-max')
  })
})

// ── supplier-photo garment prep (owner 2026-07-17) ───────────────────────────

describe('garment_prep step — reseller photos, never garment-only', () => {
  it('single on-model supplier reference is normalized and tagged for FAL extraction', async () => {
    await startSingleRescueChain({
      productImagePath: 'uploads/worn-kids-panjabi.jpg',
      modelImagePath: 'models/son.jpg',
      modelRole: 'son',
      vtonEngine: 'fal_fashn_v16',
    })
    const prep = lastAction()
    expect(prep.payload.provider).toBe('garment_prep')

    const nextId = await completeStep(prep, '', {
      garmentPrep: true,
      adultGarmentPath: 'prepped/worn-kids-panjabi-p1.png',
      childGarmentPath: null,
    })
    const tryon = actions.find((a) => a.id === nextId)!
    expect(tryon.payload.productImagePath).toBe('prepped/worn-kids-panjabi-p1.png')
    expect(tryon.payload.garmentPhotoType).toBe('model')
    expect(tryon.payload.falEndpointId).toBe('fal-ai/fashn/tryon/v1.6')
  })

  it('prep runs FIRST and real child crop drops the AI child_garment step', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({
      variant: 'father_son',
      productImagePath: 'uploads/supplier-photo.jpg',
      protectedComposite: true,
      vtonEngine: 'fal_fashn_v16',
    })
    let row = lastAction()
    expect(chainState(row).plan[0]).toBe('garment_prep')
    expect(row.payload.provider).toBe('garment_prep')
    expect(row.payload.imagePath).toBe('uploads/supplier-photo.jpg')
    expect(row.costEstimate).toBe(0) // local, free

    // worker found BOTH pieces in the reseller photo
    let nextId = await completeStep(row, '', {
      garmentPrep: true,
      adultGarmentPath: 'prepped/supplier-p1.png',
      childGarmentPath: 'prepped/supplier-p2.png',
    })
    row = actions.find((a) => a.id === nextId)!
    const st = chainState(row)
    // AI child-garment generation SKIPPED — real supplier piece used
    expect(st.plan).toEqual(['garment_prep', 'adult_tryon', 'child_tryon', 'pair_composite'])
    expect(st.childGarmentPath).toBe('prepped/supplier-p2.png')
    // adult try-on uses the adult CROP, marked as a worn photo
    expect(row.payload.productImagePath).toBe('prepped/supplier-p1.png')
    expect(row.payload.garmentPhotoType).toBe('model')

    nextId = await completeStep(row, 'generated/adult.png')
    row = actions.find((a) => a.id === nextId)!
    // child try-on garment = the REAL supplier child piece
    expect(row.payload.productImagePath).toBe('prepped/supplier-p2.png')
  })

  it('মা+মেয়ে without a split piece FAILS in Bangla — daughter must not wear the adult dress', async () => {
    seedModels(['mother', 'daughter'])
    await startFamilyChain({ variant: 'mother_daughter', productImagePath: 'uploads/merged.jpg' })
    const row = lastAction()
    const nextId = await completeStep(row, '', {
      garmentPrep: true,
      adultGarmentPath: 'prepped/merged-p1.png',
      childGarmentPath: null, // merged blob — no daughter piece
    })
    expect(nextId).toBeNull()
    const failed = lastAction()
    expect(failed.status).toBe('failed')
    expect(String((failed.result as Record<string, unknown>).error)).toContain('মেয়ের')
    expect(String(failed.summary)).toContain('গার্মেন্ট আলাদা করা যায়নি')
  })

  it('single-person supplier photo → child try-on reuses the ADULT crop', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/one-person.jpg' })
    let row = lastAction()
    let nextId = await completeStep(row, '', {
      garmentPrep: true,
      adultGarmentPath: 'prepped/one-p1.png',
      childGarmentPath: null,
    })
    row = actions.find((a) => a.id === nextId)!
    expect(chainState(row).plan).not.toContain('child_garment') // never generated
    // legacy direct-FASHN payload uses the adult crop
    expect((row.payload.fashnInputs as Record<string, string>).product_image).toBe('prepped/one-p1.png')

    nextId = await completeStep(row, 'generated/adult.png')
    row = actions.find((a) => a.id === nextId)!
    // child try-on: same adult crop, engine handles the child sizing
    expect((row.payload.fashnInputs as Record<string, string>).product_image).toBe('prepped/one-p1.png')
    expect((row.payload.fashnInputs as Record<string, string>).model_image).toBe('models/son.jpg')
  })
})
