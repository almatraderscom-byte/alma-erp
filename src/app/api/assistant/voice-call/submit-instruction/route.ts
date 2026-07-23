/**
 * POST /api/assistant/voice-call/submit-instruction — PA-3 voice → execution.
 *
 * The Gemini Live call bot's ONLY write-ish bridge: during an OWNER call, the
 * boss's work instruction ("ঈয়াফিকে কাল ছুটি দাও") is submitted here. The bot
 * itself never gets write tools — this route creates a normal HEAD turn (A2
 * worker queue), and the head executes it with every existing gate intact
 * (AIOS door, approval cards, owner-intent). The turn lands in the app chat
 * conversation, so the owner watches progress there (PA-4).
 *
 * Security:
 *  - Auth: Bearer AGENT_INTERNAL_TOKEN (same scheme as /erp-tool, /relay-report).
 *  - Defense in depth: the bot only offers submit_boss_instruction on owner
 *    calls, but we ALSO verify the referenced call record is a live owner-number
 *    call before accepting — a compromised token can't inject instructions
 *    through a staff/contact/inbound call record.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isOwnerNumber } from '@/agent/lib/voice-call'
import { createTurn } from '@/agent/lib/turn-status'
import { buildTurnJobData, enqueueTurnJob, isTurnHandoffConfigured } from '@/agent/lib/turn-queue'
import { VOICE_INSTRUCTION_PREFIX } from '@/agent/lib/voice-instruction'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** A call record older than this cannot submit instructions (stale id replay). */
const MAX_CALL_AGE_MIN = 90

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: { instruction?: unknown; callRecordId?: unknown }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const instruction = typeof body.instruction === 'string' ? body.instruction.trim().slice(0, 2000) : ''
  const callRecordId = typeof body.callRecordId === 'string' ? body.callRecordId.trim() : ''
  if (!instruction) return Response.json({ ok: false, error: 'নির্দেশটা খালি — আবার বলুন।' }, { status: 400 })
  if (!callRecordId) return Response.json({ ok: false, error: 'callRecordId required' }, { status: 400 })

  // Owner-call gate: the instruction must come from a real, recent call TO an
  // owner number. Anything else is rejected regardless of the bot's claim.
  const call = await db.agentVoiceCall.findUnique({
    where: { id: callRecordId },
    select: { id: true, toNumber: true, conversationId: true, createdAt: true },
  })
  if (!call) return Response.json({ ok: false, error: 'call_not_found' }, { status: 404 })
  if (!isOwnerNumber(String(call.toNumber ?? ''))) {
    return Response.json({ ok: false, error: 'not_an_owner_call' }, { status: 403 })
  }
  if (Date.now() - new Date(call.createdAt).getTime() > MAX_CALL_AGE_MIN * 60_000) {
    return Response.json({ ok: false, error: 'call_too_old' }, { status: 403 })
  }

  if (!isTurnHandoffConfigured()) {
    return Response.json(
      { ok: false, error: 'এই মুহূর্তে কাজের queue-টা পাওয়া যাচ্ছে না — একটু পরে আবার বলুন, নাহলে অ্যাপে লিখে দিন।' },
      { status: 503 },
    )
  }

  // Conversation: reuse the conversation the call belongs to; otherwise open a
  // fresh one so the instruction (and the head's work) is visible in the app.
  let conversationId: string | null = call.conversationId ?? null
  if (conversationId) {
    const conv = await db.agentConversation.findUnique({ where: { id: conversationId }, select: { id: true } })
    if (!conv) conversationId = null
  }
  if (!conversationId) {
    const conv = await db.agentConversation.create({
      data: { title: `🎙️ ${instruction.slice(0, 56)}`, source: 'web' },
      select: { id: true },
    })
    conversationId = conv.id as string
    // Link back so the post-call report and the instruction share one thread.
    await db.agentVoiceCall.update({ where: { id: call.id }, data: { conversationId } }).catch(() => {})
  }

  const message = `${VOICE_INSTRUCTION_PREFIX} ${instruction}`
  const turnId = await createTurn(conversationId, { executionMode: 'worker' })
  const jobData = buildTurnJobData(turnId, conversationId, { message })
  if (!jobData) return Response.json({ ok: false, error: 'turn_build_failed' }, { status: 500 })

  const jobId = await enqueueTurnJob(jobData)
  if (!jobId) {
    const { finalizeTurnIfRunning } = await import('@/agent/lib/turn-status')
    await finalizeTurnIfRunning(turnId, 'error')
    return Response.json(
      { ok: false, error: 'কাজের queue-তে দেওয়া যায়নি — একটু পরে আবার চেষ্টা করুন।' },
      { status: 502 },
    )
  }

  console.log(`[submit-instruction] call=${call.id} → turn=${turnId} conv=${conversationId}`)
  return Response.json({
    ok: true,
    turnId,
    conversationId,
    status: 'queued',
    say: 'কাজে দিয়ে দিলাম Boss — শেষ হলে জানাব। অ্যাপের চ্যাটেও দেখতে পারবেন।',
  })
}
