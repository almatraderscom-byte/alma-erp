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

vi.mock('@/lib/prisma', () => ({
  prisma: {
    agentPendingAction: {
      create: async ({ data }: { data: Omit<ActionRow, 'id' | 'createdAt' | 'result'> }) => {
        const row: ActionRow = {
          ...data,
          id: `action-${++idCounter}`,
          result: null,
          createdAt: new Date(Date.now() + idCounter), // preserve creation order
        }
        actions.push(row)
        return row
      },
      findMany: async () => [...actions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      findUnique: async ({ where }: { where: { id: string } }) =>
        actions.find((a) => a.id === where.id) ?? null,
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
  startFamilyChain,
  startSingleRescueChain,
  advanceFamilyChain,
  getChainProgress,
  FamilyChainModelError,
  type FamilyChainState,
} from '@/lib/tryon/family-chain'
import { BD_SCENES, pickScene } from '@/lib/tryon/scene-pool'

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
  actions.length = 0
  kv.clear()
  idCounter = 0
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
    const state = chainState(row)
    expect(state.plan).toEqual(['garment_prep', 'adult_tryon', 'child_garment', 'child_tryon', 'pair_merge'])
    expect(state.stepIndex).toBe(1)
    // panjabi without contrast bottom → white pajama rule must ride along
    expect(String((row.payload.fashnOptions as Record<string, unknown>).prompt)).toContain('white')
  })

  it('skips the child_garment step when the cache already has one for this product+role', async () => {
    seedModels(['mother', 'daughter'])
    kv.set('tryon_child_garment:daughter:uploads/set.jpg', 'generated/child-set.png')
    await startFamilyChain({ variant: 'mother_daughter', productImagePath: 'uploads/set.jpg' })
    const state = chainState(lastAction())
    expect(state.plan).toEqual(['garment_prep', 'adult_tryon', 'child_tryon', 'pair_merge'])
    expect(state.childGarmentPath).toBe('generated/child-set.png')
  })
})

describe('chain advance — father_son end to end', () => {
  it('carries artifacts step to step and writes the child-garment cache', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/panjabi.jpg' })
    await passPrep()

    // Step 1: adult FASHN shot done
    let nextId = await completeStep(lastAction(), 'generated/father-shot.png')
    expect(nextId).toBeTruthy()
    let row = lastAction()
    let state = chainState(row)
    expect(state.plan[state.stepIndex]).toBe('child_garment')
    expect(state.adultImagePath).toBe('generated/father-shot.png')
    // Gemini step → worker's generateImageToStorage signature
    expect(row.payload.referenceImageId).toBe('uploads/panjabi.jpg')
    expect(row.payload.creativeStudio).toBe(false) // internal, keeps gallery clean
    expect(String(row.payload.prompt)).toContain('IDENTICAL')

    // Step 2: child garment done → cache written
    nextId = await completeStep(row, 'generated/child-garment.png')
    expect(kv.get('tryon_child_garment:son:uploads/panjabi.jpg')).toBe('generated/child-garment.png')
    row = lastAction()
    state = chainState(row)
    expect(state.plan[state.stepIndex]).toBe('child_tryon')
    // child FASHN try-on dresses the SAVED son model in the generated child garment
    expect(row.payload.fashnInputs).toEqual({
      model_image: 'models/son.jpg',
      product_image: 'generated/child-garment.png',
    })

    // Step 3: child shot done
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

    // Drive both sub-chains to their pair_merge
    const drive = async (startIdx: number) => {
      let row = actions[startIdx]
      let guard = 0
      while (chainState(row).plan[chainState(row).stepIndex] !== 'pair_merge' && guard++ < 6) {
        const nextId = await completeStep(row, `generated/${row.id}.png`)
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
    })
    const first = actions.find((a) => a.id === pendingActionId)!
    expect(first.payload.provider).toBe('fashn')

    const nextId = await completeStep(first, 'generated/tryon.png')
    const rescene = actions.find((a) => a.id === nextId)!
    expect(rescene.payload.referenceImageId).toBe('generated/tryon.png')
    expect(String(rescene.payload.prompt)).toContain('background')

    const done = await completeStep(rescene, 'generated/final.png')
    expect(done).toBeNull()
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
    expect(progress!.totalSteps).toBe(5)
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
    expect(chainState(row).plan).toEqual(['garment_prep', 'adult_tryon', 'child_garment', 'child_tryon', 'pair_composite'])

    let nextId = await completeStep(row, 'generated/adult.png')
    row = actions.find((a) => a.id === nextId)!
    nextId = await completeStep(row, 'generated/child-garment.png')
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

    // run both sub-chains to their pair_composite completion
    for (const job of jobs) {
      let row = actions.find((a) => a.id === job.pendingActionId)!
      let next = await completeStep(row, `generated/${chainState(row).variant}-adult.png`)
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

    let nextId = await completeStep(row, 'generated/adult.png')
    row = actions.find((a) => a.id === nextId)!
    // child garment step stays Gemini
    expect(row.payload.provider).toBeUndefined()
    nextId = await completeStep(row, 'generated/garment.png')
    row = actions.find((a) => a.id === nextId)!
    // child tryon = fal with the generated child garment
    expect(row.payload.provider).toBe('fal')
    expect(row.payload.productImagePath).toBe('generated/garment.png')
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

  it('single-person supplier photo keeps the child_garment generation step', async () => {
    seedModels(['father', 'son'])
    await startFamilyChain({ variant: 'father_son', productImagePath: 'uploads/one-person.jpg' })
    let row = lastAction()
    const nextId = await completeStep(row, '', {
      garmentPrep: true,
      adultGarmentPath: 'prepped/one-p1.png',
      childGarmentPath: null,
    })
    row = actions.find((a) => a.id === nextId)!
    expect(chainState(row).plan).toContain('child_garment') // still generated
    // legacy direct-FASHN payload uses the adult crop
    expect((row.payload.fashnInputs as Record<string, string>).product_image).toBe('prepped/one-p1.png')
  })
})
