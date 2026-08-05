/**
 * M1 — the daemon posts a finished command's result here. The waiting agent-side
 * `awaitResult` call observes the row flip to done/failed.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, getCommandAction, getCommandContext, resolveCommand } from '@/agent/lib/mac-agent/bus'
import { capOutput } from '@/agent/lib/mac-agent/policy'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Vercel Functions reject a request body over ~4.5 MB, so an 8 MB data URI never
 * reached this handler at all — the POST failed and the command stayed unresolved
 * (Codex review round 2). 3 MB of base64 (~2.2 MB of JPEG) stays comfortably
 * under the transport limit; the daemon downscales to fit.
 */
const MAX_SCREENSHOT_CHARS = 3_000_000

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

  // A screenshot comes back as a base64 data URI, and a full Mac display is far
  // bigger than the 100k text cap — truncating it produced a "successful"
  // screenshot that could not be decoded (found in review). Images get their own
  // ceiling; text keeps the small one.
  const action = await getCommandAction(commandId)
  // ui_screenshot carries the same data-URI payload as screenshot — the text
  // cap would truncate it into an undecodable image (L8 W4; same L7 lesson).
  const capFor = (text: string) =>
    action === 'screenshot' || action === 'ui_screenshot'
      ? text.slice(0, MAX_SCREENSHOT_CHARS)
      : capOutput(text)

  // An AFTER proof may have been queued behind a UI action that outlived the
  // 25s approval window. The daemon posts it here later; reconcile the marked
  // pair into chat now, exactly once, instead of leaving a hidden screenshot row.
  // Delivery happens BEFORE resolveCommand: if storage/note/continuation has a
  // transient failure, the command stays retryable and the daemon receives 503.
  if (action === 'ui_screenshot' && body.ok && typeof body.stdout === 'string') {
    const context = await getCommandContext(commandId)
    if (context?.params.proofPhase === 'after') {
      const { deliverDeferredUiAfterProof } = await import('@/agent/lib/mac-agent/ui-visual-proof')
      const delivered = await deliverDeferredUiAfterProof({
        commandId,
        rawStdout: body.stdout.slice(0, MAX_SCREENSHOT_CHARS),
        params: context.params,
      }).catch((err): false => {
        console.warn('[mac-proof] deferred AFTER delivery failed:', err instanceof Error ? err.message : err)
        return false
      })
      if (!delivered) {
        return Response.json({ error: 'deferred_proof_delivery_failed', retryable: true }, { status: 503 })
      }
    }
  }

  // The daemon already caps output, but a compromised or buggy daemon must not be
  // able to write an unbounded blob into the row.
  const res = await resolveCommand(device.id, commandId, {
    ok: Boolean(body.ok),
    exitCode: typeof body.exitCode === 'number' ? body.exitCode : null,
    stdout: typeof body.stdout === 'string' ? capFor(body.stdout) : null,
    stderr: typeof body.stderr === 'string' ? capOutput(body.stderr) : null,
    error: typeof body.error === 'string' ? body.error.slice(0, 2_000) : null,
  })
  if (!res.ok) return Response.json({ error: 'command_not_found' }, { status: 404 })

  return Response.json({ ok: true, ignored: res.ignored ?? false })
}
