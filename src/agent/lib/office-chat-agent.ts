/**
 * Office group chat — agent one-shot reply drafting (owner-approved).
 *
 * When a staff posts in the office group, the agent drafts EXACTLY ONE reply
 * for the owner to review. Per the owner's decision this runs on the cheap
 * DeepSeek model (or-deepseek-v4-flash) — the same model the `ops` specialist
 * uses for staff coordination — never the head/Claude. The draft is stored as a
 * 'pending' row (office-chat.ts → createAgentDraft) and is NOT visible to staff
 * until the owner approves it.
 *
 * Failure is non-fatal: if DeepSeek (or its key) is unavailable, we return null
 * and the owner simply types a reply by hand.
 */
import { prisma } from '@/lib/prisma'
import { adapterFor } from '@/agent/lib/models/adapters'
import { getModel } from '@/agent/lib/models/registry'
import { calcModelTurnCostUsd } from '@/agent/lib/models/cost'
import { logCost } from '@/agent/lib/cost-events'
import { captureAgentError } from '@/agent/lib/sentry'
import { createAgentDraft, hasAgentReplyFor, type ChatMessage } from '@/agent/lib/office-chat'

/** Owner-tunable lever could move this later; locked to DeepSeek per owner decision. */
const DRAFT_MODEL_ID = 'or-deepseek-v4-flash'
const MAX_CONTEXT_MESSAGES = 12
const DRAFT_TIMEOUT_MS = 20_000

const SYSTEM_PROMPT =
  'তুমি ALMA Lifestyle অফিসের সহকারী এজেন্ট, অফিস গ্রুপ চ্যাটে। ' +
  'একজন স্টাফ গ্রুপে একটি বার্তা দিয়েছে। তোমার কাজ: মালিকের (Boss) হয়ে ওই বার্তার একটি ছোট, ভদ্র, সহায়ক বাংলা উত্তরের খসড়া তৈরি করা। ' +
  'নিয়ম: (১) শুধু একটি উত্তর দাও, সর্বোচ্চ ২-৩ বাক্য। (২) পুরোপুরি বাংলায়, ইসলামি সৌজন্য বজায় রেখে, স্টাফকে সম্মানের সাথে সম্বোধন করো। ' +
  '(৩) কোনো হারাম/অনুপযুক্ত বিষয় নয়। (৪) নিশ্চিত না হলে অনুমান করবে না — ভদ্রভাবে আরও তথ্য চাও বা Boss দেখে নেবেন বলো। ' +
  '(৫) শুধু উত্তরের টেক্সট দাও, কোনো ভূমিকা/ব্যাখ্যা/উদ্ধৃতি চিহ্ন নয়।'

type ContextRow = { authorType: string; body: string; authorStaffId: string | null }

/** Build a compact, readable transcript for the model from recent posted/pending rows. */
async function buildContext(businessId: string, targetId: string): Promise<{ transcript: string; targetBody: string } | null> {
  const rows = await prisma.officeGroupMessage.findMany({
    where: { businessId, status: { in: ['posted', 'pending'] } },
    orderBy: { createdAt: 'desc' },
    take: MAX_CONTEXT_MESSAGES,
    select: { id: true, authorType: true, body: true, authorStaffId: true, createdAt: true },
  })
  const target = rows.find((r) => r.id === targetId)
  if (!target) return null

  const staffIds = [...new Set(rows.map((r) => r.authorStaffId).filter((v): v is string => Boolean(v)))]
  const nameById = new Map<string, string>()
  if (staffIds.length > 0) {
    const staff = await prisma.agentStaff.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } })
    for (const s of staff) nameById.set(s.id, s.name)
  }

  const label = (r: ContextRow) =>
    r.authorType === 'owner' ? 'Boss' : r.authorType === 'agent' ? 'Agent' : (r.authorStaffId && nameById.get(r.authorStaffId)) || 'স্টাফ'

  const transcript = rows
    .slice()
    .reverse()
    .map((r) => `${label(r)}: ${r.body}`)
    .join('\n')

  return { transcript, targetBody: `${label(target)}: ${target.body}` }
}

/**
 * Draft the agent's single reply to a group message. Returns the pending draft
 * (owner must approve), the already-existing reply if one was made, or null on
 * failure / when there's nothing useful to draft.
 */
export async function generateAgentReplyDraft(args: {
  businessId: string
  replyToId: string
}): Promise<ChatMessage | null> {
  // "Agent replies once": never draft twice for the same message.
  if (await hasAgentReplyFor(args.replyToId, args.businessId)) return null

  const ctx = await buildContext(args.businessId, args.replyToId)
  if (!ctx) return null

  let model
  try {
    model = getModel(DRAFT_MODEL_ID)
  } catch {
    return null
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DRAFT_TIMEOUT_MS)
  let text = ''
  let inputTokens = 0
  let outputTokens = 0
  try {
    const adapter = adapterFor(model.provider)
    const userPrompt =
      `সাম্প্রতিক কথোপকথন (পুরনো → নতুন):\n${ctx.transcript}\n\n` +
      `যে বার্তার উত্তর দিতে হবে:\n${ctx.targetBody}\n\n` +
      `উপরের বার্তার একটি ছোট বাংলা উত্তর লেখো (২-৩ বাক্য, শুধু উত্তর):`
    for await (const ev of adapter.streamTurn({
      apiModel: model.apiModel,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [],
      thinking: 'none',
      signal: controller.signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text
      else if (ev.type === 'usage') {
        inputTokens = ev.inputTokens
        outputTokens = ev.outputTokens
      }
    }
  } catch (err) {
    void captureAgentError(err, 'office_group_reply_draft', { route: 'office-chat-agent' })
    return null
  } finally {
    clearTimeout(timer)
  }

  const body = text.trim()
  if (!body) return null

  // Best-effort cost logging (DeepSeek chat); never block the draft on it.
  if (inputTokens > 0 || outputTokens > 0) {
    try {
      const costUsd = calcModelTurnCostUsd(model, { inputTokens, outputTokens })
      await logCost({
        provider: 'openrouter',
        kind: 'chat',
        units: { inputTokens, outputTokens, model: model.apiModel, role: 'office_group_reply' },
        costUsd,
        dedupKey: `office_group_draft:${args.replyToId}`,
      })
    } catch {
      /* cost logging is best-effort */
    }
  }

  // Re-check the guard right before insert to avoid a race double-draft.
  if (await hasAgentReplyFor(args.replyToId, args.businessId)) return null
  return createAgentDraft({ businessId: args.businessId, replyToId: args.replyToId, body })
}
