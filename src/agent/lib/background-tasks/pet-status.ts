import { prisma } from '@/lib/prisma'
import { listBackgroundAttentionActions } from '@/agent/lib/background-tasks/active-turns'
import { messageContentToText } from '@/agent/lib/message-recall'

export const PET_COMPLETION_MAX_AGE_MS = 24 * 60 * 60 * 1000
export const PET_RUNNING_MAX_AGE_MS = 30 * 60 * 1000
const PET_MAX_RUNNING_ITEMS = 12
const PET_MAX_TERMINAL_ITEMS = 8

export type GlobalOfficePetItemStatus =
  | 'running'
  | 'attention'
  | 'completed'
  | 'failed'

export type GlobalOfficePetItem = {
  id: string
  actionId?: string | null
  turnId: string | null
  conversationId: string | null
  status: GlobalOfficePetItemStatus
  title: string
  detail: string
  updatedAt: string
  dismissible: boolean
}

export type GlobalOfficePetCompletion = {
  turnId: string
  conversationId: string
  preview: string | null
  completedAt: string
}

export type GlobalOfficePetStatus = {
  runningCount: number
  attentionCount: number
  items: GlobalOfficePetItem[]
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
  items?: GlobalOfficePetItem[]
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
    items: input.items ?? [],
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
  const runningCutoff = new Date(now.getTime() - PET_RUNNING_MAX_AGE_MS)

  const [runningTurns, attention, terminalTurns] = await Promise.all([
    prisma.agentTurn.findMany({
      // The companion is a presentation surface, not a reaper. Bounding the
      // visible window prevents abandoned historical "running" rows from
      // becoming unexplained 20/21 badges while the recovery policy remains
      // responsible for changing their durable status.
      where: {
        status: 'running',
        startedAt: { gte: runningCutoff },
      },
      orderBy: [
        { updatedAt: 'desc' },
        { id: 'desc' },
      ],
      take: PET_MAX_RUNNING_ITEMS,
      select: {
        id: true,
        conversationId: true,
        userMessageId: true,
        startedAt: true,
        updatedAt: true,
      },
    }),
    listBackgroundAttentionActions(),
    prisma.agentTurn.findMany({
      where: {
        status: { in: ['done', 'error'] },
        continuationNeeded: false,
        finishedAt: { gte: completionCutoff },
      },
      orderBy: [
        { finishedAt: 'desc' },
        { id: 'desc' },
      ],
      take: PET_MAX_TERMINAL_ITEMS,
      select: {
        id: true,
        conversationId: true,
        status: true,
        userMessageId: true,
        assistantMessageId: true,
        finishedAt: true,
      },
    }),
  ])

  const allTurns = [...runningTurns, ...terminalTurns]
  const conversationIds = [...new Set([
    ...allTurns.map((turn) => turn.conversationId),
    ...attention
      .map((action) => action.conversationId)
      .filter((id): id is string => Boolean(id)),
  ])]
  const messageIds = [...new Set(allTurns.flatMap((turn) => [
    turn.userMessageId,
    'assistantMessageId' in turn ? turn.assistantMessageId : null,
  ]).filter((id): id is string => Boolean(id)))]

  const [conversations, messages, deliveries] = await Promise.all([
    conversationIds.length
      ? prisma.agentConversation.findMany({
          where: { id: { in: conversationIds } },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    messageIds.length
      ? prisma.agentMessage.findMany({
          where: { id: { in: messageIds } },
          select: { id: true, content: true },
        })
      : Promise.resolve([]),
    terminalTurns.length
      ? prisma.agentTurnNotificationDelivery.findMany({
          where: { turnId: { in: terminalTurns.map((turn) => turn.id) } },
          select: { turnId: true, preview: true },
        })
      : Promise.resolve([]),
  ])

  const conversationTitle = new Map(
    conversations.map((row) => [row.id, cleanPetText(row.title, 72)]),
  )
  const messageText = new Map(
    messages.map((row) => [row.id, cleanPetText(messageContentToText(row.content), 110)]),
  )
  const deliveryPreview = new Map(
    deliveries.map((row) => [row.turnId, cleanPetText(row.preview, 110)]),
  )

  const runningItems: GlobalOfficePetItem[] = runningTurns.map((turn) => {
    const input = turn.userMessageId ? messageText.get(turn.userMessageId) : null
    return {
      id: `turn:${turn.id}`,
      turnId: turn.id,
      conversationId: turn.conversationId,
      status: 'running',
      title: conversationTitle.get(turn.conversationId) || input || 'Agent কাজ',
      detail: input && input !== conversationTitle.get(turn.conversationId)
        ? input
        : 'Agent কাজ করছে',
      updatedAt: turn.updatedAt.toISOString(),
      dismissible: false,
    }
  })

  const attentionItems: GlobalOfficePetItem[] = attention.map((action) => ({
    id: `action:${action.id}`,
    actionId: action.id,
    turnId: null,
    conversationId: action.conversationId,
    status: 'attention',
    title: conversationTitle.get(action.conversationId ?? '') || 'আপনার অনুমোদন দরকার',
    detail: cleanPetText(action.summary, 110) || 'Agent আপনার সিদ্ধান্তের অপেক্ষায় আছে',
    updatedAt: action.createdAt,
    dismissible: false,
  }))

  const terminalItems: GlobalOfficePetItem[] = terminalTurns.flatMap((turn) => {
    if (!turn.finishedAt) return []
    const input = turn.userMessageId ? messageText.get(turn.userMessageId) : null
    const assistant = turn.assistantMessageId ? messageText.get(turn.assistantMessageId) : null
    const preview = deliveryPreview.get(turn.id) || assistant
    return [{
      id: `turn:${turn.id}`,
      turnId: turn.id,
      conversationId: turn.conversationId,
      status: turn.status === 'done' ? 'completed' : 'failed',
      title: conversationTitle.get(turn.conversationId) || input || 'Agent কাজ',
      detail: preview || (turn.status === 'done'
        ? 'কাজ শেষ হয়েছে'
        : 'কাজটি শেষ করা যায়নি'),
      updatedAt: turn.finishedAt.toISOString(),
      dismissible: true,
    }]
  })

  const latestDoneTurn = terminalTurns.find(
    (turn) => turn.status === 'done' && turn.finishedAt,
  )

  return projectGlobalOfficePetStatus({
    runningCount: runningItems.length,
    attentionCount: attention.length,
    latestCompletion: latestDoneTurn?.finishedAt
      ? {
          turnId: latestDoneTurn.id,
          conversationId: latestDoneTurn.conversationId,
          preview: deliveryPreview.get(latestDoneTurn.id)
            || (latestDoneTurn.assistantMessageId
              ? messageText.get(latestDoneTurn.assistantMessageId)
              : null)
            || null,
          completedAt: latestDoneTurn.finishedAt,
        }
      : null,
    items: [...attentionItems, ...runningItems, ...terminalItems],
    now,
  })
}

function cleanPetText(value: string | null | undefined, maximum: number): string | null {
  const cleaned = value?.replace(/\s+/g, ' ').trim()
  if (!cleaned) return null
  if (cleaned.length <= maximum) return cleaned
  return `${cleaned.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`
}
