import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { logCost } from '@/agent/lib/cost-events'
import {
  liveVoiceUsageDedupKey,
  parseLiveVoiceUsageReport,
  priceLiveVoiceUsageSegment,
} from '@/agent/lib/live-voice-usage'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: unknown
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const parsed = parseLiveVoiceUsageReport(body)
  if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 })

  let costUsd = 0
  let loggedSegments = 0
  let unresolvedTranscriptionSegments = 0
  for (const [index, segment] of parsed.report.segments.entries()) {
    const priced = priceLiveVoiceUsageSegment(segment)
    costUsd += priced.costUsd
    if (priced.unresolvedTranscription) unresolvedTranscriptionSegments += 1
    const row = await logCost({
      provider: 'gemini',
      kind: 'call',
      units: priced.units,
      costUsd: priced.costUsd,
      conversationId: parsed.report.conversationId,
      dedupKey: liveVoiceUsageDedupKey(token.sub, parsed.report.callId, index),
    })
    if (row) loggedSegments += 1
  }

  return Response.json({
    ok: true,
    costUsd,
    loggedSegments,
    unresolvedTranscriptionSegments,
  })
}
