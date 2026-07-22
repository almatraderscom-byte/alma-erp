/**
 * Phase 10 — ask_user clarifying question buttons.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import { createHash } from 'crypto'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

function normalized(value: string): string {
  return value.toLowerCase().replace(/\s+/g, ' ').trim()
}

/** ask_user is for missing information, never a post-work review/permission loop. */
export function shouldCreateAskCard(input: {
  ownerText: string
  question: string
  options?: string[]
}): boolean {
  const owner = normalized(input.ownerText)
  const question = normalized(input.question)
  const options = normalized((input.options ?? []).join(' '))
  const ownerAskedForCopy = /(caption|primary\s*text|content|copy|ক্যাপশন).*(likh|lekho|লিখ|write|draft|detail|বিস্তারিত)|(likh|লিখ|write|draft).*(caption|primary\s*text|content|copy|ক্যাপশন)/i.test(owner)
  // "paste/post কোরো না" is a prohibition, not permission to publish. Remove
  // complete negated action phrases before looking for an affirmative effect.
  const effectWord = '(?:paste|পেস্ট|post|পোস্ট|publish|ads?\\s*manager(?:-?এ)?|send|পাঠা(?:ও|বেন|তে)?)'
  const negatedEffect = new RegExp(
    `(?:কোথাও\\s*)?${effectWord}(?:\\s*(?:বা|or|/|,)\\s*${effectWord})*[^।.!?\\n]{0,24}?(?:কোরো|করো|করবেন|করবা|করিস|দেও|দিও|দেবে)?\\s*না|` +
    `(?:do\\s+not|don't|never|without)\\s+(?:[^।.!?\\n]{0,16}\\s+)?${effectWord}`,
    'gi',
  )
  const affirmativeOwner = owner.replace(negatedEffect, ' ')
  const ownerAskedToPublish = new RegExp(effectWord, 'i').test(affirmativeOwner)
  const postWorkAsk = `${question} ${options}`
  const reviewOrNewEffect = /(কেমন\s*লাগ|ঠিক\s*আছে|এখন\s*(?:কি|কী)\s*কর|এরপর\s*(?:কি|কী)|paste|পেস্ট|post|পোস্ট|publish|ads?\s*manager|send|পাঠাব|approve|অনুমোদন|wording\s*পরিবর্তন|নতুনভাবে\s*লিখ|রেখে\s*দিন|use\s*কর)/i.test(postWorkAsk)
  if (ownerAskedForCopy && !ownerAskedToPublish && reviewOrNewEffect) return false
  return true
}

type OwnerMessageRow = {
  id: string
  content: unknown
  createdAt: Date
  usage?: unknown
}

function messageText(row: OwnerMessageRow | undefined): string {
  if (!Array.isArray(row?.content)) return ''
  return row.content
    .filter((b: unknown) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'text')
    .map((b: unknown) => String((b as { text?: unknown }).text ?? ''))
    .join('\n')
}

function steeringTarget(row: OwnerMessageRow | undefined): string | null {
  if (!row?.usage || typeof row.usage !== 'object') return null
  const steering = (row.usage as { steering?: unknown }).steering
  if (!steering || typeof steering !== 'object') return null
  const target = (steering as { targetTurnId?: unknown }).targetTurnId
  return typeof target === 'string' && target ? target : null
}

/**
 * Reconstruct only the current owner request. A live steering message is not a
 * fresh task: pair every update for its target turn with the immediately
 * preceding ordinary owner message. Older unrelated chat stays out.
 */
export function currentOwnerRequestText(rowsNewestFirst: OwnerMessageRow[]): string {
  const latest = rowsNewestFirst[0]
  if (!latest) return ''
  const target = steeringTarget(latest)
  if (!target) return messageText(latest)

  const steeringRows = rowsNewestFirst.filter((row) => steeringTarget(row) === target)
  const oldestSteeringIndex = Math.max(...steeringRows.map((row) => rowsNewestFirst.indexOf(row)))
  const base = rowsNewestFirst.slice(oldestSteeringIndex + 1).find((row) => !steeringTarget(row))
  return [base, ...steeringRows.slice().reverse()]
    .map(messageText)
    .filter(Boolean)
    .join('\n')
}

const ask_user: AgentTool = {
  name: 'ask_user',
  description:
    'When a request is ambiguous and the answer materially changes the work, ask ONE clarifying question with 2–4 specific tappable options. ' +
    'Never open-ended questions. At most one ask per request.',
  input_schema: {
    type: 'object' as const,
    properties: {
      question: { type: 'string', description: 'The clarifying question in Bangla' },
      options: {
        type: 'array',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 4,
        description: '2–4 specific answer options the owner can tap',
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['question', 'options'],
  },
  handler: async (input) => {
    const question = String(input.question ?? '').trim()
    const rawOptions = Array.isArray(input.options) ? input.options.map(String) : []
    const options = rawOptions.map((o) => o.trim()).filter(Boolean)

    if (!question) return { success: false, error: 'question is required' }
    if (options.length < 2 || options.length > 4) {
      return { success: false, error: 'options must have 2–4 items' }
    }

    const conversationId = input.conversationId ? String(input.conversationId) : null
    if (!conversationId) return { success: false, error: 'conversationId is required' }

    try {
      const ownerRows: OwnerMessageRow[] = await db.agentMessage.findMany({
        where: { conversationId, role: 'user' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 24,
        select: { id: true, content: true, createdAt: true, usage: true },
      })
      const latestOwner = ownerRows[0]
      const ownerText = currentOwnerRequestText(ownerRows)
      if (!shouldCreateAskCard({ ownerText, question, options })) {
        return {
          success: false,
          error: 'Boss already gave a clear drafting instruction. Complete it in chat; do not ask for review or permission to publish elsewhere.',
        }
      }

      // Phase 5: bind the question to the conversation's single in-flight
      // workflow AT CREATION (both head paths run this handler), so the owner's
      // answer can move the template state machine (e.g. image preview confirm).
      // The turn-end stamping in run-owner-turn stays as a safety net.
      let workflowRunId: string | null = null
      try {
        const { listActiveWorkflowRuns } = await import('@/agent/lib/workflow-run')
        const active = await listActiveWorkflowRuns(conversationId, 2)
        if (active.length === 1) workflowRunId = active[0].id
      } catch { /* fail-open — the card just goes unbound */ }

      const serializedOptions = JSON.stringify(options)
      const existing = await db.agentAskCard.findFirst({
        where: { conversationId, status: 'pending' },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      })
      // A second ask_user call during the SAME owner request always reuses the
      // first card, even if the model rephrased it. A genuinely newer owner
      // message supersedes an older unanswered card and may ask one new thing.
      if (existing && latestOwner?.createdAt && existing.createdAt >= latestOwner.createdAt) {
        let existingOptions: string[] = options
        try {
          const parsed = JSON.parse(String(existing.options))
          if (Array.isArray(parsed)) existingOptions = parsed.map(String)
        } catch { /* keep validated current options as display fallback */ }
        return {
          success: true,
          data: {
            askCardId: existing.id as string,
            question: existing.question as string,
            options: existingOptions,
            message: 'Existing clarifying question reused — wait for the owner choice.',
            deduplicated: true,
          },
        }
      }

      // One conversation can wait on only one current clarification. A newer
      // owner request supersedes any older unresolved row before its new card.
      await db.agentAskCard.updateMany({
        where: { conversationId, status: 'pending' },
        data: { status: 'superseded' },
      })
      // Deterministic per owner-message identity. Concurrent/retried model calls
      // can rephrase the question or receive different tool-call ids, but they
      // still upsert ONE database row and therefore ONE actionable UI card.
      const ownerRequestKey = String(latestOwner?.id ?? `${conversationId}:${ownerText}`)
      const deterministicCardId = `ask_${createHash('sha256')
        .update(`${conversationId}:${ownerRequestKey}`)
        .digest('hex').slice(0, 32)}`
      const card = await db.agentAskCard.upsert({
        where: { id: deterministicCardId },
        create: {
          id: deterministicCardId,
          conversationId,
          question,
          options: serializedOptions,
          status: 'pending',
          ...(workflowRunId ? { workflowRunId } : {}),
        },
        update: {},
      })

      let persistedOptions = options
      try {
        const parsed = JSON.parse(String(card.options))
        if (Array.isArray(parsed)) persistedOptions = parsed.map(String)
      } catch { /* keep the validated options for display */ }

      return {
        success: true,
        data: {
          askCardId: card.id as string,
          question: String(card.question),
          options: persistedOptions,
          message: 'Clarifying question shown to owner — wait for their choice.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ASK_TOOLS: AgentTool[] = [ask_user]
