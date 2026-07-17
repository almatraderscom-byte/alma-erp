import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { option?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const option = typeof body.option === 'string' ? body.option.trim() : ''
  if (!option) return Response.json({ error: 'option_required' }, { status: 400 })
  if (option.length > 500) return Response.json({ error: 'option_too_long' }, { status: 400 })

  // Phase 34: one idempotent, run-binding answer path (ask-cards.ts).
  // Free-text answers are FIRST-CLASS: the card always shows an "Other (write
  // your own)" row, so the owner's own words are a valid answer. The SAME
  // answer repeated (double tap / reconnect) is a success that changes
  // nothing; a DIFFERENT answer after one is recorded is refused — the first
  // answer already advanced the bound run. The bound WorkflowRun advances
  // HERE (version-guarded, idempotent), so resume never waits for the next
  // turn and the answer text is bound state — never re-read as a fresh
  // owner instruction.
  const { answerAskCard } = await import('@/agent/lib/ask-cards')
  const result = await answerAskCard(params.id, option)
  if (!result.ok) {
    if (result.reason === 'not_found') return Response.json({ error: 'not_found' }, { status: 404 })
    return Response.json(
      { error: 'already_answered', selectedOption: result.card?.selectedOption ?? null },
      { status: 409 },
    )
  }
  return Response.json({
    success: true,
    option,
    idempotent: result.alreadyAnswered,
    workflowRunId: result.card?.workflowRunId ?? null,
  })
}
