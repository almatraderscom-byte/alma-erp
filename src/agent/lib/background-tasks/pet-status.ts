import { prisma } from '@/lib/prisma'
import { listBackgroundAttentionActions } from '@/agent/lib/background-tasks/active-turns'

export const PET_COMPLETION_MAX_AGE_MS = 24 * 60 * 60 * 1000

export type GlobalOfficePetCompletion = {
  turnId: string
  conversationId: string
  preview: string | null
  completedAt: string
}

export type GlobalOfficePetStatus = {
  runningCount: number
  attentionCount: number
  latestCompletion: GlobalOfficePetCompletion | null
  updatedAt: string
}

type PetStatusProjectionInput = {
  runningCount: number
  attentionCount: number
  latestCompletion: {
    turnId: string
    conversationId: string
    preview: string | null
    completedAt: Date
  } | null
  now: Date
}

/**
 * Pure wire projection kept separate from Prisma so count clamping and the
 * completion contract remain cheap to unit-test.
 */
export function projectGlobalOfficePetStatus(
  input: PetStatusProjectionInput,
): GlobalOfficePetStatus {
  const clampCount = (value: number) => Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0
  return {
    runningCount: clampCount(input.runningCount),
    attentionCount: clampCount(input.attentionCount),
    latestCompletion: input.latestCompletion
      ? {
          turnId: input.latestCompletion.turnId,
          conversationId: input.latestCompletion.conversationId,
          preview: input.latestCompletion.preview,
          completedAt: input.latestCompletion.completedAt.toISOString(),
        }
      : null,
    updatedAt: input.now.toISOString(),
  }
}

/**
 * One owner-global status snapshot for the app-wide Office Robot.
 *
 * This deliberately does not reuse `listActiveBackgroundTurns()`: that surface
 * hides ordinary active-chat turns by design, while the Robot must show all
 * recent owner work regardless of which tab is visible.
 */
export async function getGlobalOfficePetStatus(
  now: Date = new Date(),
): Promise<GlobalOfficePetStatus> {
  const completionCutoff = new Date(now.getTime() - PET_COMPLETION_MAX_AGE_MS)

  const [runningCount, attention, latestDoneTurn] = await Promise.all([
    prisma.agentTurn.count({
      // Do not age out legitimate long-running work. Stale running rows belong
      // to the turn-recovery/reaper policy, not the presentation layer.
      where: { status: 'running' },
    }),
    listBackgroundAttentionActions(),
    // AgentTurn is the universal completion ledger. NotificationDelivery covers
    // only web-chat pushes and would silently omit autonomous/worker completions.
    prisma.agentTurn.findFirst({
      where: {
        status: 'done',
        continuationNeeded: false,
        finishedAt: { gte: completionCutoff },
      },
      orderBy: [
        { finishedAt: 'desc' },
        { id: 'desc' },
      ],
      select: {
        id: true,
        conversationId: true,
        finishedAt: true,
      },
    }),
  ])

  return projectGlobalOfficePetStatus({
    runningCount,
    attentionCount: attention.length,
    latestCompletion: latestDoneTurn?.finishedAt
      ? {
          turnId: latestDoneTurn.id,
          conversationId: latestDoneTurn.conversationId,
          preview: null,
          completedAt: latestDoneTurn.finishedAt,
        }
      : null,
    now,
  })
}
