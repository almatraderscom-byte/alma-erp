/**
 * POST /api/assistant/internal/cost-event — worker + app cost logging.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { logCost, type LogCostInput } from '@/agent/lib/cost-events'
import type { CostKind, CostProvider } from '@/agent/lib/pricing'

export const runtime = 'nodejs'

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

const PROVIDERS = new Set<CostProvider>(['anthropic', 'openai', 'gemini', 'veo', 'google_tts', 'twilio', 'elevenlabs'])
const KINDS = new Set<CostKind>(['chat', 'embedding', 'transcribe', 'tts', 'image', 'video', 'call'])

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: Partial<LogCostInput> & { occurredAt?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const { provider, kind, units, costUsd } = body
  if (!provider || !PROVIDERS.has(provider as CostProvider)) {
    return Response.json({ error: 'invalid_provider' }, { status: 400 })
  }
  if (!kind || !KINDS.has(kind as CostKind)) {
    return Response.json({ error: 'invalid_kind' }, { status: 400 })
  }
  if (typeof costUsd !== 'number') {
    return Response.json({ error: 'costUsd_required' }, { status: 400 })
  }

  const result = await logCost({
    provider: provider as CostProvider,
    kind: kind as CostKind,
    units: (units && typeof units === 'object' ? units : {}) as Record<string, number | string>,
    costUsd,
    conversationId: body.conversationId ?? null,
    jobId: body.jobId ?? null,
    dedupKey: body.dedupKey ?? null,
    occurredAt: body.occurredAt ? new Date(body.occurredAt) : undefined,
  })

  if (!result) return Response.json({ error: 'log_failed' }, { status: 500 })
  return Response.json({ ok: true, id: result.id })
}
