/**
 * M1 — the daemon posts a finished command's result here. The waiting agent-side
 * `awaitResult` call observes the row flip to done/failed.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, resolveCommand } from '@/agent/lib/mac-agent/bus'
import { capOutput } from '@/agent/lib/mac-agent/policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

interface ResultBody {
  commandId?: string
  ok?: boolean
  exitCode?: number
  stdout?: string
  stderr?: string
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

  // The daemon already caps output, but a compromised or buggy daemon must not be
  // able to write an unbounded blob into the row.
  const res = await resolveCommand(device.id, commandId, {
    ok: Boolean(body.ok),
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
    stdout: typeof body.stdout === 'string' ? capOutput(body.stdout) : null,
    stderr: typeof body.stderr === 'string' ? capOutput(body.stderr) : null,
    error: typeof body.error === 'string' ? body.error.slice(0, 2_000) : null,
  })
  if (!res.ok) return Response.json({ error: 'command_not_found' }, { status: 404 })

  return Response.json({ ok: true, ignored: res.ignored ?? false })
}
