/**
 * POST /api/assistant/internal/code-search
 * READ-ONLY repo grep/read for agent self-diagnosis.
 * Vercel proxies to the VPS worker (full repo); local dev uses AGENT_REPO_PATH when set.
 */
import { type NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { runCodeSearch, type CodeSearchBody } from '@/lib/diagnostic/code-search'

export const runtime = 'nodejs'

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch {
    return false
  }
}

async function proxyToWorker(body: CodeSearchBody, token: string) {
  const base = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.replace(/\/$/, '')
  if (!base) return null
  const res = await fetch(`${base}/code-search`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const data = await res.json().catch(() => ({}))
  return NextResponse.json(data, { status: res.status })
}

export async function POST(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  if (!checkToken(req)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  let body: CodeSearchBody
  try {
    body = await req.json() as CodeSearchBody
  } catch {
    return NextResponse.json({ error: 'bad json' }, { status: 400 })
  }

  if (body.mode === 'grep' && (!body.query || body.query.length > 200)) {
    return NextResponse.json({ error: 'bad query' }, { status: 400 })
  }
  if (body.mode === 'read' && !body.file) {
    return NextResponse.json({ error: 'file required' }, { status: 400 })
  }
  if (body.mode !== 'grep' && body.mode !== 'read') {
    return NextResponse.json({ error: 'bad mode' }, { status: 400 })
  }

  const workerUrl = process.env.AGENT_WORKER_DIAGNOSTIC_URL?.trim()
  if (workerUrl) {
    try {
      const proxied = await proxyToWorker(body, token)
      if (proxied) return proxied
    } catch (err) {
      console.warn('[code-search] worker proxy failed:', err)
    }
  }

  try {
    const result = await runCodeSearch(body)
    if ('error' in result && result.error === 'bad mode') {
      return NextResponse.json(result, { status: 400 })
    }
    if ('error' in result) {
      return NextResponse.json(result, { status: 400 })
    }
    return NextResponse.json(result)
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
