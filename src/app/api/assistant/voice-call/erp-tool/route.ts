/**
 * POST /api/assistant/voice-call/erp-tool — mid-call ERP reads for the Gemini Live bot.
 *
 * During a two-way call the bot (worker/scripts/gemini-live-bot.mjs) lets Gemini Live
 * call functions; each call is bridged here. We run the SAME agent read-tools the
 * assistant uses (executeTool), so there is zero ERP logic in the bot and no new data
 * path — just a thin, token-authed, READ-ONLY allowlist. Owner-call only (the bot only
 * exposes these functions when callType is owner), so business data never reaches a
 * staff/contact callee.
 *
 * Auth: Bearer AGENT_INTERNAL_TOKEN (same scheme as /relay-report). Kill-switch via
 * requireAgentEnabled(). Never add a write/mutating tool to ERP_CALL_TOOLS.
 */
import { type NextRequest } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { executeTool } from '@/agent/tools/registry'

export const runtime = 'nodejs'
export const maxDuration = 30

/** Read-only tools the agent may call while on a phone call. READ-ONLY ONLY. */
const ERP_CALL_TOOLS = new Set<string>([
  'get_sales_summary',
  'get_orders',
  'get_inventory_status',
  'get_product_details',
  'get_customer_summary',
  'get_dashboard_snapshot',
  'get_current_datetime',
  // Staff/office visibility (owner ask 2026-07-23: the call agent guessed a
  // staff name because it had NO attendance tool — never again). Reads only.
  'get_attendance',
  'get_all_staff',
  'get_staff_tasks',
  'get_lunch_status',
  'get_pending_approvals',
])

function verifyToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}

/** Today in Asia/Dhaka as YYYY-MM-DD. */
function dhakaToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyToken(token)) return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })

  let body: { tool?: string; args?: Record<string, unknown>; businessId?: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ ok: false, error: 'invalid_json' }, { status: 400 })
  }

  const tool = String(body.tool ?? '')
  if (!ERP_CALL_TOOLS.has(tool)) {
    return Response.json({ ok: false, error: `tool "${tool}" is not callable mid-call` }, { status: 403 })
  }

  const businessId = body.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
  const args: Record<string, unknown> = { ...(body.args ?? {}) }
  // get_sales_summary requires from/to — default to "today" so the model can just ask
  // "today's sales" without knowing the date.
  if (tool === 'get_sales_summary') {
    if (!args.from) args.from = dhakaToday()
    if (!args.to) args.to = dhakaToday()
  }

  try {
    const result = await executeTool(tool, args, { businessId })
    // Keep the payload small — it becomes a Gemini Live toolResponse the model must read.
    let data = result.success ? (result.data ?? null) : null
    let json = JSON.stringify(data)
    if (json && json.length > 6000) {
      json = json.slice(0, 6000)
      data = { truncated: true, preview: json }
    }
    return Response.json({ ok: result.success, tool, data, error: result.success ? null : (result.error ?? 'tool_failed') })
  } catch (err) {
    return Response.json({ ok: false, tool, error: err instanceof Error ? err.message : String(err) }, { status: 500 })
  }
}
