export type DemoEffectClass = 'local' | 'paid_generation' | 'external_publish'

export type DemoOperation = {
  id: string
  label: string
  target: string
  before: string
  after: string
  effect: DemoEffectClass
  estimatedCostBdt: number
}

export type DemoCompositionState = {
  version: number
  durationSec: number
  caption: string
  captionStartSec: number
  musicVolume: number
  safeZone: boolean
  clipCount: number
}

export const INITIAL_DEMO_STATE: DemoCompositionState = {
  version: 12,
  durationSec: 24,
  caption: 'ঈদের নতুন গল্প',
  captionStartSec: 2.4,
  musicVolume: 18,
  safeZone: true,
  clipCount: 3,
}

export const DEMO_PLAN_FINGERPRINT = 'plan_8f2c1a_v12'

export const DEMO_AGENT_PLAN: readonly DemoOperation[] = [
  {
    id: 'OP-1041',
    label: 'Tighten opening product shot',
    target: 'video.hero-01.range',
    before: '00:00.0–00:04.8',
    after: '00:00.0–00:03.6',
    effect: 'local',
    estimatedCostBdt: 0,
  },
  {
    id: 'OP-1042',
    label: 'Move primary caption to first beat',
    target: 'captions.cap-01.start',
    before: '00:02.4',
    after: '00:01.2',
    effect: 'local',
    estimatedCostBdt: 0,
  },
  {
    id: 'OP-1043',
    label: 'Lower music under owner voice',
    target: 'audio.music-01.volume',
    before: '18%',
    after: '12%',
    effect: 'local',
    estimatedCostBdt: 0,
  },
  {
    id: 'OP-1044',
    label: 'Generate 4-second product close-up',
    target: 'video.track-01@00:14.0',
    before: 'No clip',
    after: 'New AI video clip',
    effect: 'paid_generation',
    estimatedCostBdt: 75,
  },
  {
    id: 'OP-1045',
    label: 'Publish approved reel to Meta',
    target: 'distribution.meta',
    before: 'Not scheduled',
    after: 'External post',
    effect: 'external_publish',
    estimatedCostBdt: 0,
  },
] as const

export type DemoApplyResult = {
  state: DemoCompositionState
  applied: DemoOperation[]
  blocked: DemoOperation[]
  auditId: string
}

export function applyDemoPlan(
  current: DemoCompositionState,
  approvedFingerprint: string,
): DemoApplyResult {
  if (approvedFingerprint !== DEMO_PLAN_FINGERPRINT) {
    throw new Error('plan_approval_required')
  }

  const applied = DEMO_AGENT_PLAN.filter((operation) => operation.effect === 'local')
  const blocked = DEMO_AGENT_PLAN.filter((operation) => operation.effect !== 'local')

  return {
    state: {
      ...current,
      version: current.version + 1,
      durationSec: 22.8,
      captionStartSec: 1.2,
      musicVolume: 12,
    },
    applied,
    blocked,
    auditId: `AUD-${current.version + 1}-8F2C`,
  }
}

export function rollbackDemoPlan(
  current: DemoCompositionState,
  rollbackPoint: DemoCompositionState,
): DemoCompositionState {
  return {
    ...rollbackPoint,
    version: current.version + 1,
  }
}
