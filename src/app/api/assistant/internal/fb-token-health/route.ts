/**
 * GET /api/assistant/internal/fb-token-health
 * Runtime check — Vercel production FB page tokens (masked, no secrets returned).
 */
import { NextRequest, NextResponse } from 'next/server'
import { metaGraphBase } from '@/lib/meta-version'
import { timingSafeEqual } from 'crypto'

export const runtime = 'nodejs'

const PAGES = [
  { name: 'Alma Lifestyle', envKey: 'FB_PAGE_TOKEN_LIFESTYLE', pageId: '1044848232034171' },
  { name: 'Alma Online Shop', envKey: 'FB_PAGE_TOKEN_ONLINESHOP', pageId: '827260860637393' },
] as const

function checkToken(req: NextRequest): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN
  if (!expected) return false
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
  } catch (err) {
    console.warn('[fb-token-health] token compare failed:', err instanceof Error ? err.message : err)
    return false
  }
}

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const results = []
  for (const page of PAGES) {
    const token = process.env[page.envKey]
    if (!token) {
      results.push({ name: page.name, pageId: page.pageId, configured: false, valid: false, error: 'not_set' })
      continue
    }

    try {
      const debugRes = await fetch(
        `${metaGraphBase()}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(15_000) },
      )
      const debug = (await debugRes.json()) as { data?: { is_valid?: boolean; type?: string; expires_at?: number }; error?: { message?: string } }
      const d = debug.data
      if (!d?.is_valid) {
        results.push({
          name: page.name,
          pageId: page.pageId,
          configured: true,
          valid: false,
          error: debug.error?.message ?? 'invalid_token',
        })
        continue
      }

      const convRes = await fetch(
        `${metaGraphBase()}/${page.pageId}/conversations?limit=1&access_token=${encodeURIComponent(token)}`,
        { signal: AbortSignal.timeout(15_000) },
      )
      const conv = (await convRes.json()) as { error?: { message?: string } }

      results.push({
        name: page.name,
        pageId: page.pageId,
        configured: true,
        valid: true,
        type: d.type ?? 'unknown',
        expires: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'never',
        inboxOk: !conv.error,
        inboxError: conv.error?.message?.slice(0, 120),
      })
    } catch (err) {
      results.push({
        name: page.name,
        pageId: page.pageId,
        configured: true,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const allOk = results.every((r) => r.configured && r.valid)
  return NextResponse.json({ ok: allOk, pages: results, checkedAt: new Date().toISOString() })
}
