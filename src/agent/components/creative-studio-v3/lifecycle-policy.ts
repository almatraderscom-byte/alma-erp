import type {
  StudioV3LifecycleCapability,
  StudioV3LifecycleRole,
  StudioV3LifecycleWorkspace,
} from '@/agent/components/creative-studio-v3/lifecycle-client'

export const STUDIO_V3_LIFECYCLE_MODE_COPY: Record<
  StudioV3LifecycleCapability,
  { label: string; description: string }
> = {
  preview: {
    label: 'Preview',
    description: 'Revalidates the current composition, source version and review pin without creating a job.',
  },
  render: {
    label: 'Render',
    description: 'Queues only the registered local composition-manifest renderer at ৳0.',
  },
  export: {
    label: 'Export',
    description: 'Requires an exact current approval, then queues a verified local JSON manifest.',
  },
  dry_run: {
    label: 'Dry run',
    description: 'The accepted intent contract is distinct, but no executable production adapter is mounted.',
  },
  schedule: {
    label: 'Schedule',
    description: 'Planning is distinct from execution; no schedule mutation is exposed by this V3 client.',
  },
  live_publish: {
    label: 'Live publish',
    description: 'External Meta execution is hard-disabled and absent from the V3 client.',
  },
}

export const STUDIO_V3_LIFECYCLE_ROLE_LABEL: Record<
  StudioV3LifecycleRole,
  string
> = {
  owner: 'Owner',
  creator: 'Creator',
  reviewer: 'Reviewer',
}

export function studioV3LifecycleIdempotencyKey(action: string): string {
  return `lifecycle:${action}:${globalThis.crypto.randomUUID()}`
}

export function lifecyclePresentation(input: {
  capability: StudioV3LifecycleCapability
  role: StudioV3LifecycleRole
  workspace: StudioV3LifecycleWorkspace | null
}) {
  const rollout = input.workspace?.rollouts[input.capability] ?? null
  const externalLocked = input.capability === 'live_publish'
  const executableMode = (
    input.capability === 'preview'
    || input.capability === 'render'
    || input.capability === 'export'
  )
  const ownerMutation = input.role === 'owner' && executableMode
  const executable = ownerMutation && !externalLocked
  return {
    enabled: Boolean(rollout?.enabled) && !externalLocked,
    executable,
    ownerMutation,
    status: externalLocked
      ? 'Hard off'
      : !rollout
        ? 'Not loaded'
        : rollout.enabled
          ? executableMode
            ? input.role === 'owner'
              ? input.capability === 'preview'
                ? 'Owner preview admitted'
                : 'Owner local queue admitted'
              : 'Read only'
            : 'Flag admitted · adapter unavailable'
          : rollout.reason === 'duplicate_scope_ambiguous'
            ? 'Ambiguous · fail closed'
            : 'Default off',
  }
}

export function lifecycleReviewReadiness(
  review: {
    publishReady: boolean
    approvalInvalidatedReason: string | null
  } | null,
): {
  status: string
  invalidation: string
} {
  if (!review) {
    return {
      status: 'Not hydrated',
      invalidation: 'Not reported',
    }
  }
  if (review.approvalInvalidatedReason === 'composition_pin_missing') {
    return {
      status: 'Pin missing · not publish-ready',
      invalidation: 'Composition pin missing',
    }
  }
  if (review.publishReady && !review.approvalInvalidatedReason) {
    return {
      status: 'Exact pin current',
      invalidation: 'None reported',
    }
  }
  return {
    status: 'Not publish-ready',
    invalidation: review.approvalInvalidatedReason ?? 'None reported',
  }
}
