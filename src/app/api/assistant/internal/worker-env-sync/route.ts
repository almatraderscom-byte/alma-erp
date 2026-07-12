/**
 * POST /api/assistant/internal/worker-env-sync — copy a WHITELISTED env var
 * from this app's (Vercel) environment to the VPS worker's .env, server-to-server.
 *
 * Why: the worker needed OPENAI_API_KEY for the GPT Image 2 engine (2026-07-12),
 * but the value is sensitive-flagged in Vercel (unpullable) and pasting keys
 * through chats/terminals is banned. This route lets the OWNER trigger a sync
 * where no human ever sees the value: read process.env here → POST to the
 * worker's /env-set (internal-token authed) → pm2 picks it up on next restart.
 *
 * Safety: owner session only, hard whitelist of key NAMES, value never returned.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'

export const runtime = 'nodejs'

const SYNCABLE_KEYS = new Set(['OPENAI_API_KEY', 'FAL_KEY'])

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  const body = (await req.json().catch(() => ({}))) as { key?: string }
  const key = String(body.key ?? '')
  if (!SYNCABLE_KEYS.has(key)) {
    return Response.json({ error: 'key_not_syncable' }, { status: 422 })
  }

  const value = process.env[key]
  if (!value) {
    return Response.json({ error: 'value_missing_on_app', key }, { status: 404 })
  }

  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  const internalToken = process.env.AGENT_INTERNAL_TOKEN
  if (!workerUrl || !internalToken) {
    return Response.json({ error: 'worker_env_not_configured' }, { status: 503 })
  }

  const res = await fetch(`${workerUrl}/env-set`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalToken}`,
    },
    body: JSON.stringify({ key, value }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    return Response.json({ error: `worker_env_set_${res.status}`, detail: err.slice(0, 200) }, { status: 502 })
  }
  return Response.json({ ok: true, key, synced: true })
}
