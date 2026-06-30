/**
 * Phase E — extension posts a command result (and optional screenshot) back here.
 * The waiting `runCommand` call on the agent side observes the row flip to done/failed.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, resolveCommand } from '@/agent/lib/live-browser/companion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Cap a single result body (screenshots are jpeg dataURLs) to keep memory sane.
const MAX_SCREENSHOT_CHARS = 3_500_000

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

interface ResultBody {
  commandId?: string
  ok?: boolean
  data?: unknown
  screenshot?: string | null
  error?: string
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const device = await authenticateDevice(bearer(req))
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  let body: ResultBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 })
  }

  const commandId = String(body.commandId ?? '').trim()
  if (!commandId) return Response.json({ error: 'commandId_required' }, { status: 400 })

  let screenshot = typeof body.screenshot === 'string' ? body.screenshot : null
  if (screenshot && screenshot.length > MAX_SCREENSHOT_CHARS) screenshot = null

  const res = await resolveCommand(device.id, commandId, {
    ok: Boolean(body.ok),
    data: body.data,
    screenshot,
    error: typeof body.error === 'string' ? body.error : undefined,
  })
  if (!res.ok) return Response.json({ error: 'command_not_found' }, { status: 404 })

  return Response.json({ ok: true, ignored: res.ignored ?? false })
}
