import { lifecycleFingerprint, type StudioCompositionPin } from './lifecycle-contract'

export type StudioLifecycleRolloutFlags = {
  lifecycleEnabled: boolean
  canaryEnabled: boolean
  dualReadEnabled: boolean
  legacyFallbackEnabled: boolean
  livePublishEnabled: boolean
  paidRenderEnabled: boolean
  voiceProviderEnabled: boolean
}

export const DEFAULT_STUDIO_LIFECYCLE_FLAGS: StudioLifecycleRolloutFlags = {
  lifecycleEnabled: false,
  canaryEnabled: false,
  dualReadEnabled: false,
  legacyFallbackEnabled: true,
  livePublishEnabled: false,
  paidRenderEnabled: false,
  voiceProviderEnabled: false,
}

export type StudioLifecycleFlagScope = {
  ownerId: string
  brandProfileId: string
  projectId: string
  role: 'owner' | 'creator' | 'reviewer'
  capability: 'preview' | 'render' | 'export' | 'dry_run' | 'schedule' | 'live_publish'
}

export type StudioLifecycleScopedFlag = {
  id: string
  scope: Partial<StudioLifecycleFlagScope>
  enabled: boolean
  legacyFallbackEnabled?: boolean
  dualReadEnabled?: boolean
  canaryPercent?: number
  canarySalt?: string
}

export type StudioLifecycleRolloutDecision = {
  enabled: boolean
  legacyFallbackAvailable: boolean
  fallbackExecution: 'client_orchestrated' | 'none'
  dualReadEnabled: boolean
  canary: 'not_configured' | 'included' | 'excluded'
  matchedFlagId: string | null
  reason: 'default_off' | 'matched' | 'duplicate_scope_ambiguous'
}

function scopeMatches(flag: StudioLifecycleScopedFlag, scope: StudioLifecycleFlagScope): boolean {
  return Object.entries(flag.scope).every(([key, value]) => value === scope[key as keyof StudioLifecycleFlagScope])
}

function scopeSpecificity(flag: StudioLifecycleScopedFlag): number {
  const weights: Record<keyof StudioLifecycleFlagScope, number> = {
    ownerId: 1,
    role: 2,
    brandProfileId: 4,
    projectId: 8,
    capability: 16,
  }
  return Object.keys(flag.scope).reduce(
    (score, key) => score + weights[key as keyof StudioLifecycleFlagScope],
    0,
  )
}

function deterministicCanary(scope: StudioLifecycleFlagScope, salt: string): number {
  const digest = lifecycleFingerprint({ scope, salt })
  return Number.parseInt(digest.slice(0, 8), 16) % 100
}

/**
 * Default-off lifecycle admission. A legacy flag only tells the caller that a
 * legacy route remains available; this evaluator never executes that fallback.
 */
export function evaluateStudioLifecycleRollout(input: {
  scope: StudioLifecycleFlagScope
  flags: StudioLifecycleScopedFlag[]
}): StudioLifecycleRolloutDecision {
  const matches = input.flags.filter((flag) => scopeMatches(flag, input.scope))
    .sort((a, b) => scopeSpecificity(b) - scopeSpecificity(a))
  const flag = matches[0]
  if (!flag) {
    return {
      enabled: false,
      legacyFallbackAvailable: true,
      fallbackExecution: 'client_orchestrated',
      dualReadEnabled: false,
      canary: 'not_configured',
      matchedFlagId: null,
      reason: 'default_off',
    }
  }
  if (
    matches.length > 1
    && scopeSpecificity(matches[1]) === scopeSpecificity(flag)
  ) {
    return {
      enabled: false,
      legacyFallbackAvailable: matches.every((entry) => entry.legacyFallbackEnabled !== false),
      fallbackExecution: matches.every((entry) => entry.legacyFallbackEnabled !== false)
        ? 'client_orchestrated'
        : 'none',
      dualReadEnabled: false,
      canary: 'not_configured',
      matchedFlagId: null,
      reason: 'duplicate_scope_ambiguous',
    }
  }
  const percent = flag.canaryPercent == null ? null : Math.max(0, Math.min(100, Math.floor(flag.canaryPercent)))
  const canary = percent == null
    ? 'not_configured' as const
    : deterministicCanary(input.scope, flag.canarySalt ?? flag.id) < percent
      ? 'included' as const
      : 'excluded' as const
  return {
    enabled: flag.enabled && canary !== 'excluded',
    legacyFallbackAvailable: flag.legacyFallbackEnabled !== false,
    fallbackExecution: flag.legacyFallbackEnabled !== false ? 'client_orchestrated' : 'none',
    dualReadEnabled: flag.dualReadEnabled === true,
    canary,
    matchedFlagId: flag.id,
    reason: 'matched',
  }
}

export type StudioLifecycleOperationsInput = {
  queuedJobs?: number
  oldestJobAgeMinutes?: number
  queueLatencyP95Ms?: number
  rejectedCommands?: number
  staleConflicts?: number
  providerErrorRate7d?: number
  providerBalanceBdt?: number | null
  providerSpendUsd7d?: number
  workerHeartbeatAgeMinutes?: number | null
  artifactsPendingVerification?: number
  reviewInvalidations7d?: number
  publishOutcomes?: Partial<Record<'published' | 'failedRetryable' | 'needsReview' | 'canceled', number>>
  goldenEval?: { passed?: number; total?: number }
  cache?: { hitRate?: number; staleEntries?: number }
  flags?: StudioLifecycleRolloutFlags
}

/** Typed data only: UI desks choose wording and presentation. */
export function toStudioLifecycleOperationsView(input: StudioLifecycleOperationsInput) {
  const flags = input.flags ?? DEFAULT_STUDIO_LIFECYCLE_FLAGS
  const missingSignals: string[] = []
  const finite = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null
  const whole = (name: string, value: unknown): number | null => {
    const number = finite(value)
    if (number === null) {
      missingSignals.push(name)
      return null
    }
    return Math.max(0, Math.floor(number))
  }
  const decimal = (name: string, value: unknown, maximum = Number.POSITIVE_INFINITY): number | null => {
    const number = finite(value)
    if (number === null) {
      missingSignals.push(name)
      return null
    }
    return Math.max(0, Math.min(maximum, number))
  }
  const killSwitches = {
    lifecycle: !flags.lifecycleEnabled,
    livePublish: !flags.livePublishEnabled,
    paidRender: !flags.paidRenderEnabled,
    voiceProvider: !flags.voiceProviderEnabled,
  }
  const providerErrorRate7d = decimal('providerErrorRate7d', input.providerErrorRate7d)
  const providerHealth = providerErrorRate7d === null
    ? 'unknown'
    : providerErrorRate7d >= 0.1
    ? 'critical'
    : providerErrorRate7d >= 0.03
      ? 'degraded'
      : 'healthy'
  const workerHeartbeatAgeMinutes = input.workerHeartbeatAgeMinutes == null
    ? (missingSignals.push('workerHeartbeatAgeMinutes'), null)
    : whole('workerHeartbeatAgeMinutes', input.workerHeartbeatAgeMinutes)
  const workerHealth = workerHeartbeatAgeMinutes == null
    ? 'unknown'
    : workerHeartbeatAgeMinutes > 15
      ? 'offline'
      : workerHeartbeatAgeMinutes > 5
        ? 'delayed'
        : 'healthy'
  const goldenTotal = whole('goldenEval.total', input.goldenEval?.total)
  const goldenPassedRaw = whole('goldenEval.passed', input.goldenEval?.passed)
  const goldenPassed = goldenTotal === null || goldenPassedRaw === null ? null : Math.min(goldenTotal, goldenPassedRaw)
  const providerBalanceBdt = input.providerBalanceBdt == null
    ? (missingSignals.push('providerBalanceBdt'), null)
    : decimal('providerBalanceBdt', input.providerBalanceBdt)
  return {
    queuedJobs: whole('queuedJobs', input.queuedJobs),
    oldestJobAgeMinutes: whole('oldestJobAgeMinutes', input.oldestJobAgeMinutes),
    queueLatencyP95Ms: whole('queueLatencyP95Ms', input.queueLatencyP95Ms),
    rejectedCommands: whole('rejectedCommands', input.rejectedCommands),
    staleConflicts: whole('staleConflicts', input.staleConflicts),
    providerHealth,
    providerErrorRate7d,
    providerBalanceBdt: providerBalanceBdt === null ? null : Math.round(providerBalanceBdt),
    providerSpendUsd7d: decimal('providerSpendUsd7d', input.providerSpendUsd7d),
    workerHealth,
    workerHeartbeatAgeMinutes,
    artifactsPendingVerification: whole('artifactsPendingVerification', input.artifactsPendingVerification),
    reviewInvalidations7d: whole('reviewInvalidations7d', input.reviewInvalidations7d),
    publishOutcomes: {
      published: whole('publishOutcomes.published', input.publishOutcomes?.published),
      failedRetryable: whole('publishOutcomes.failedRetryable', input.publishOutcomes?.failedRetryable),
      needsReview: whole('publishOutcomes.needsReview', input.publishOutcomes?.needsReview),
      canceled: whole('publishOutcomes.canceled', input.publishOutcomes?.canceled),
    },
    goldenEval: {
      passed: goldenPassed,
      total: goldenTotal,
      passRate: goldenTotal === null || goldenPassed === null || goldenTotal === 0 ? null : goldenPassed / goldenTotal,
    },
    cache: {
      hitRate: decimal('cache.hitRate', input.cache?.hitRate, 1),
      staleEntries: whole('cache.staleEntries', input.cache?.staleEntries),
    },
    killSwitches,
    missingSignals,
  }
}

export type StudioLifecycleAttribution = {
  eventId: string
  compositionId: string
  compositionVersionId: string
  artifactVersionId: string
  campaignPackId: string | null
  batchId: string | null
  lifecycleFingerprint: string
  capturedAt: string
}

export function buildStudioLifecycleAttribution(input: {
  eventId: string
  pin: StudioCompositionPin
  lifecycleFingerprint: string
  capturedAt?: string
}): StudioLifecycleAttribution {
  return {
    eventId: input.eventId,
    compositionId: input.pin.compositionId,
    compositionVersionId: input.pin.compositionVersionId,
    artifactVersionId: input.pin.artifactVersionId,
    campaignPackId: input.pin.campaignPackId,
    batchId: input.pin.batchId,
    lifecycleFingerprint: input.lifecycleFingerprint,
    capturedAt: input.capturedAt ?? new Date(0).toISOString(),
  }
}

export function compareStudioLifecycleDualRead(input: {
  legacy: Record<string, unknown>
  lifecycle: Record<string, unknown>
}): { equal: boolean; legacyFingerprint: string; lifecycleFingerprint: string } {
  const legacyFingerprint = lifecycleFingerprint(input.legacy)
  const lifecycleFingerprintValue = lifecycleFingerprint(input.lifecycle)
  return { equal: legacyFingerprint === lifecycleFingerprintValue, legacyFingerprint, lifecycleFingerprint: lifecycleFingerprintValue }
}

export function certifyStudioLifecycleRollback(input: {
  flags: StudioLifecycleRolloutFlags
  pendingExternalEffects: number
  ambiguousEffects: number
}): { certified: boolean; requiredActions: string[] } {
  const requiredActions: string[] = []
  if (input.flags.livePublishEnabled) requiredActions.push('disable_live_publish')
  if (input.flags.lifecycleEnabled) requiredActions.push('disable_lifecycle')
  if (!input.flags.legacyFallbackEnabled) requiredActions.push('enable_legacy_fallback')
  if (input.pendingExternalEffects > 0 || input.ambiguousEffects > 0) requiredActions.push('quarantine_and_reconcile_external_effects')
  return { certified: requiredActions.length === 0, requiredActions }
}
