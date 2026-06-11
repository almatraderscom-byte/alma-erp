/**
 * POST /api/assistant/internal/cost-reconcile — nightly drift check (OpenAI where possible).
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { prisma } from '@/lib/prisma'

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

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any

  const rows: Array<{ provider: string; total: string }> = await db.$queryRawUnsafe(
    `SELECT provider, SUM(cost_usd)::text AS total
     FROM agent_cost_events
     WHERE occurred_at >= $1 AND provider IN ('openai', 'anthropic')
     GROUP BY provider`,
    since,
  )

  const logged = Object.fromEntries(rows.map((r) => [r.provider, parseFloat(r.total) || 0]))
  const drift: Array<{ provider: string; loggedUsd: number; reportedUsd: number; pctDrift: number; note?: string }> = []

  // Anthropic: no usage API with standard API key — document only
  if (logged.anthropic != null) {
    drift.push({
      provider: 'anthropic',
      loggedUsd: logged.anthropic,
      reportedUsd: logged.anthropic,
      pctDrift: 0,
      note: 'No programmatic usage API with API key — reconcile via Anthropic Console billing',
    })
  }

  // OpenAI: organization usage API requires admin key + org ID — skip if not configured
  const orgId = process.env.OPENAI_ORG_ID
  const adminKey = process.env.OPENAI_ADMIN_API_KEY ?? process.env.OPENAI_API_KEY
  let openaiReported = 0
  if (orgId && adminKey && logged.openai != null) {
    try {
      const start = Math.floor(since.getTime() / 1000)
      const end = Math.floor(Date.now() / 1000)
      const res = await fetch(
        `https://api.openai.com/v1/organization/costs?start_time=${start}&end_time=${end}`,
        { headers: { Authorization: `Bearer ${adminKey}`, 'OpenAI-Organization': orgId } },
      )
      if (res.ok) {
        const data = await res.json() as { data?: Array<{ amount?: { value?: number } }> }
        openaiReported = (data.data ?? []).reduce((s, b) => s + (b.amount?.value ?? 0), 0) / 100
      }
    } catch {
      /* fall through */
    }
  }

  if (logged.openai != null) {
    const reported = openaiReported || logged.openai
    const pct = reported > 0 ? Math.abs((logged.openai - reported) / reported) * 100 : 0
    drift.push({
      provider: 'openai',
      loggedUsd: logged.openai,
      reportedUsd: reported,
      pctDrift: openaiReported ? pct : 0,
      note: openaiReported ? undefined : 'Set OPENAI_ORG_ID + admin key for live reconciliation',
    })
  }

  return Response.json({ ok: true, since: since.toISOString(), drift })
}
