/**
 * M1 — daemon long-poll. The Mac daemon calls this on a loop with its bearer token
 * and gets back the next queued command, or nothing when idle.
 *
 * The daemon is NOT trusted to be the only gate: it re-classifies every command it
 * receives before running it. This endpoint's job is delivery, not permission.
 */
import { type NextRequest } from 'next/server'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { authenticateDevice, claimNextCommand, isMacAgentEnabled } from '@/agent/lib/mac-agent/bus'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, no-cache, max-age=0, must-revalidate',
} as const

function bearer(req: NextRequest): string {
  const h = req.headers.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7).trim() : ''
}

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const device = await authenticateDevice(bearer(req))
  if (!device) return Response.json({ error: 'unauthorized' }, { status: 401 })

  // Capability report — sent once per daemon start (first poll), merged into
  // device.meta so tools can pick the RIGHT Mac when several are online. The
  // pair-time meta goes stale forever; this refreshes on every restart.
  const caps = req.headers.get('x-agent-capabilities')
  // Acknowledged explicitly: the daemon keeps sending the header until it
  // sees capsAck, so a transient write failure here does not leave the
  // device capability-less until its next restart (Codex P2).
  let capsAck: boolean | undefined
  if (caps !== null) {
    try {
      const capabilities = caps.split(',').map((c) => c.trim()).filter(Boolean).slice(0, 20)
      const existing = (
        await prisma.macAgentDevice.findUnique({ where: { id: device.id }, select: { meta: true } })
      )?.meta as object | null
      await prisma.macAgentDevice.update({
        where: { id: device.id },
        data: {
          meta: { ...(existing ?? {}), capabilities, capabilitiesAt: new Date().toISOString() },
        },
      })
      capsAck = true
    } catch {
      capsAck = false
    }
  }

  // Kill-switch OFF ⇒ the daemon stays connected (so the owner sees it online and
  // can flip the switch back) but never receives work.
  if (!(await isMacAgentEnabled())) {
    return Response.json(
      { command: null, paused: true, ...(capsAck !== undefined ? { capsAck } : {}) },
      { headers: NO_STORE_HEADERS },
    )
  }

  const command = await claimNextCommand(device.id)
  return Response.json(
    { command, ...(capsAck !== undefined ? { capsAck } : {}) },
    { headers: NO_STORE_HEADERS },
  )
}
