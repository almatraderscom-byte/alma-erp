/**
 * Phase 10 — ask_user clarifying question buttons.
 */
import { prisma } from '@/lib/prisma'
import type { AgentTool } from './registry'
import { createHash } from 'crypto'
import { hasAffirmativeExternalAction, isCopyOnlyOwnerRequest } from '@/agent/lib/owner-intent-contract'

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
  const ownerAskedForCopy = isCopyOnlyOwnerRequest(owner) ||
    /(caption|primary\s*text|content|copy|ক্যাপশন).*(likh|lekho|লিখ|write|draft|detail|বিস্তারিত)|(likh|লিখ|write|draft).*(caption|primary\s*text|content|copy|ক্যাপশন)/i.test(owner)
  const ownerAskedToPublish = hasAffirmativeExternalAction(owner)
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
    'When a request is ambiguous and the answer materially changes the work, ask your clarifying question(s) with 2–4 specific tappable options each. ' +
    'Never open-ended questions. At most ONE ask_user call per request — if you need answers to SEVERAL things, put them ALL in the `questions` array of that one call (max 4); ' +
    'never split one decision moment across multiple cards or turns. Boss answers everything on one card in one go.\n' +
    'RECOMMEND FIRST (owner rule): options[0] MUST be the option YOU would choose — it is shown to Boss with a ' +
    '"প্রস্তাবিত" badge. Never hand him a flat list of equal choices and make him decide alone; you have the ' +
    'context, so take a position and put it first.\n' +
    'Asking ENDS your turn — the question is your reply. Do not write an answer or keep working underneath it; ' +
    'Boss taps an option and the work resumes from there.',
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
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        description: 'Use when you have MORE THAN ONE question: every question of this request, each with its own 2–4 options. When present, top-level question/options may be omitted (the first entry stands in for them).',
        items: {
          type: 'object',
          properties: {
            question: { type: 'string', description: 'The question in Bangla' },
            options: {
              type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 4,
              description: '2–4 tappable options; options[0] = your recommendation',
            },
          },
          required: ['question', 'options'],
        },
      },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: [],
  },
  handler: async (input) => {
    // Normalize to a question GROUP. `questions` (1–4 entries) is the
    // multi-question path; bare question/options remains valid and equals a
    // one-entry group. The first entry mirrors into the legacy question/options
    // columns and wire fields so pre-multi clients keep working.
    type AskEntry = { question: string; options: string[] }
    const entries: AskEntry[] = []
    if (Array.isArray(input.questions) && input.questions.length > 0) {
      for (const raw of input.questions) {
        const q = String((raw as { question?: unknown })?.question ?? '').trim()
        const rawOpts = (raw as { options?: unknown })?.options
        const opts = (Array.isArray(rawOpts) ? rawOpts.map(String) : [])
          .map((o) => o.trim()).filter(Boolean)
        if (!q) return { success: false, error: 'every questions[] entry needs a question' }
        if (opts.length < 2 || opts.length > 4) {
          return { success: false, error: 'every questions[] entry needs 2–4 options' }
        }
        entries.push({ question: q, options: opts })
      }
      if (entries.length > 4) return { success: false, error: 'questions supports at most 4 entries' }
    } else {
      const question = String(input.question ?? '').trim()
      const rawOptions = Array.isArray(input.options) ? input.options.map(String) : []
      const options = rawOptions.map((o) => o.trim()).filter(Boolean)
      if (!question) return { success: false, error: 'question is required' }
      if (options.length < 2 || options.length > 4) {
        return { success: false, error: 'options must have 2–4 items' }
      }
      entries.push({ question, options })
    }
    const question = entries[0].question
    const options = entries[0].options
    const questionsJson = entries.length > 1 ? JSON.stringify(entries) : null

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
      const combinedQuestion = entries.map((e) => e.question).join(' ')
      const combinedOptions = entries.flatMap((e) => e.options)
      if (!shouldCreateAskCard({ ownerText, question: combinedQuestion, options: combinedOptions })) {
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
        let existingQuestions: AskEntry[] | null = null
        try {
          const parsedGroup = existing.questions ? JSON.parse(String(existing.questions)) : null
          if (Array.isArray(parsedGroup) && parsedGroup.length > 0) {
            existingQuestions = parsedGroup as AskEntry[]
          }
        } catch { /* single-question card */ }
        return {
          success: true,
          data: {
            askCardId: existing.id as string,
            question: existing.question as string,
            options: existingOptions,
            ...(existingQuestions ? { questions: existingQuestions } : {}),
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
          ...(questionsJson ? { questions: questionsJson } : {}),
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

      let persistedQuestions: AskEntry[] | null = entries.length > 1 ? entries : null
      try {
        const parsedGroup = card.questions ? JSON.parse(String(card.questions)) : null
        if (Array.isArray(parsedGroup) && parsedGroup.length > 0) {
          persistedQuestions = parsedGroup as AskEntry[]
        }
      } catch { /* keep validated entries */ }

      return {
        success: true,
        data: {
          askCardId: card.id as string,
          question: String(card.question),
          options: persistedOptions,
          ...(persistedQuestions ? { questions: persistedQuestions } : {}),
          message: entries.length > 1
            ? 'All questions shown to the owner on ONE card — wait for the combined answer.'
            : 'Clarifying question shown to owner — wait for their choice.',
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ASK_TOOLS: AgentTool[] = [ask_user]
