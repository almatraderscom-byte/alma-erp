import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { executeTool } from '@/agent/tools/registry'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 20

/**
 * Fast lane for the live AI voice call (owner spec 2026-07-23): simple
 * business LOOKUPS answer in seconds by executing one whitelisted READ-ONLY
 * tool directly — no head model, no memory pass, no claim verifier. Anything
 * that writes, decides, or needs context still goes through the head via
 * run_agent_turn. Owner-only, same gate as /api/assistant/live-session.
 */
const READ_ONLY_TOOLS = new Set([
  'get_attendance',
  'get_sales_summary',
  'get_orders',
  'get_dashboard_snapshot',
  'get_inventory_status',
  'get_salah_status',
  'get_pending_approvals',
  'get_prayer_times',
])

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const owner = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!owner?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(owner)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as {
    tool?: string
    input?: Record<string, unknown>
    business_id?: string
  }
  const tool = String(body.tool || '').trim()
  if (!READ_ONLY_TOOLS.has(tool)) {
    return Response.json({ error: 'tool_not_allowed' }, { status: 400 })
  }

  const started = Date.now()
  try {
    const result = await Promise.race([
      executeTool(tool, body.input && typeof body.input === 'object' ? body.input : {}, {
        businessId: body.business_id || 'ALMA_LIFESTYLE',
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('voice_tool_timeout_15s')), 15_000),
      ),
    ])
    // Compact payload: Gemini only needs enough to phrase a short spoken answer.
    const raw = JSON.stringify(result.success ? result.data ?? result : result)
    return Response.json({
      ok: result.success !== false,
      tool,
      ms: Date.now() - started,
      result: raw.length > 6000 ? raw.slice(0, 6000) + '…[truncated]' : raw,
    })
  } catch (err) {
    return Response.json({
      ok: false,
      tool,
      ms: Date.now() - started,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    }, { status: 200 })
  }
}
