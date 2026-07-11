/**
 * P1 live WATCH panel feed (roadmap P1: "owner sees each step + screenshot stream
 * as it happens; pause/stop button").
 *
 *   GET  ?limit=30 → { enabled, devices, steps, latestScreenshot }
 *        steps = the owner's recent live-browser commands (newest first) with a
 *        short human target summary — the per-step audit log, live.
 *        latestScreenshot = dataURL of the newest command that captured one, so
 *        the panel shows what the agent is looking at RIGHT NOW.
 *
 *   POST { action: 'stop' | 'resume' }
 *        stop   → kill-switch OFF + all queued commands failed('owner_stop') —
 *                 the server-side big red button (the on-page STOP ⏹ and the
 *                 popup pause remain the extension-side switches).
 *        resume → kill-switch back ON.
 *
 * Owner-session (or internal-token) auth — same pattern as open-tasks.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'
import { extractBearerToken, verifyAgentInternalToken } from '@/lib/agent-internal-auth'
import { requireAgentEnabled } from '@/agent/lib/guards'
import {
  isLiveBrowserEnabled,
  setLiveBrowserEnabled,
  listOwnerDevices,
} from '@/agent/lib/live-browser/companion'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

async function checkAuth(req: NextRequest): Promise<boolean> {
  if (verifyAgentInternalToken(extractBearerToken(req.headers.get('authorization')))) return true
  const session = await getServerSession(authOptions)
  return !!(session && isSystemOwner(session))
}

/** Short owner-readable target for a step, e.g. `click "লগ ইন"` — no page dumps. */
function summarizeParams(action: string, params: unknown): string {
  const p = (params ?? {}) as Record<string, unknown>
  const pick = (v: unknown) => (typeof v === 'string' ? v.slice(0, 60) : '')
  const target = pick(p.text) || pick(p.selector) || pick(p.ref)
  switch (action) {
    case 'navigate':
      return pick(p.url)
    case 'type':
      return `${target ? target + ' ← ' : ''}"${pick(p.value)}"`
    case 'press':
      return pick(p.key)
    case 'select_option':
      return `${target}: ${pick(p.option)}`
    case 'scroll':
      return typeof p.by === 'number' ? `${p.by}px` : ''
    case 'wait':
      return typeof p.ms === 'number' ? `${p.ms}ms` : ''
    default:
      return target
  }
}

export async function GET(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate
  if (!(await checkAuth(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get('limit')) || 30, 5), 60)
  const enabled = await isLiveBrowserEnabled()
  const devices = await listOwnerDevices()
  const deviceIds = devices.map((d) => d.id)
  const nameById = new Map(devices.map((d) => [d.id, d.name]))

  if (deviceIds.length === 0) {
    return NextResponse.json({ enabled, devices, steps: [], latestScreenshot: null })
  }

  // Step list WITHOUT result payloads (screenshots are ~100KB each — too heavy
  // for a 2.5s poll). The newest screenshot comes from a tiny second query.
  const rows = await prisma.liveBrowserCommand.findMany({
    where: { deviceId: { in: deviceIds } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      deviceId: true,
      action: true,
      params: true,
      status: true,
      error: true,
      createdAt: true,
      resolvedAt: true,
    },
  })
  const steps = rows.map((r) => ({
    id: r.id,
    device: nameById.get(r.deviceId) ?? 'Chrome',
    action: r.action,
    target: summarizeParams(r.action, r.params),
    status: r.status,
    error: r.error,
    at: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
  }))

  // Newest captured screenshot among the last few resolved commands.
  let latestScreenshot: string | null = null
  let latestScreenshotAt: string | null = null
  const withResults = await prisma.liveBrowserCommand.findMany({
    where: { deviceId: { in: deviceIds }, status: 'done', resolvedAt: { not: null } },
    orderBy: { resolvedAt: 'desc' },
    take: 6,
    select: { result: true, resolvedAt: true },
  })
  for (const row of withResults) {
    const shot = (row.result as Record<string, unknown> | null)?.screenshot
    if (typeof shot === 'string' && shot.startsWith('data:image')) {
      latestScreenshot = shot
      latestScreenshotAt = row.resolvedAt?.toISOString() ?? null
      break
    }
  }

  return NextResponse.json({ enabled, devices, steps, latestScreenshot, latestScreenshotAt })
}

export async function POST(req: NextRequest) {
  const gate = requireAgentEnabled()
  if (gate) return gate
  if (!(await checkAuth(req))) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await req.json().catch(() => ({}))) as { action?: string }
  if (body.action === 'stop') {
    await setLiveBrowserEnabled(false)
    const devices = await listOwnerDevices()
    if (devices.length) {
      await prisma.liveBrowserCommand.updateMany({
        where: { deviceId: { in: devices.map((d) => d.id) }, status: { in: ['queued', 'delivered'] } },
        data: { status: 'failed', error: 'owner_stop (watch panel)', resolvedAt: new Date() },
      })
    }
    return NextResponse.json({ ok: true, enabled: false })
  }
  if (body.action === 'resume') {
    await setLiveBrowserEnabled(true)
    return NextResponse.json({ ok: true, enabled: true })
  }
  return NextResponse.json({ error: 'action must be stop | resume' }, { status: 400 })
}
