/**
 * GET /api/assistant/internal/website-smoke
 * Runtime check — Vercel production website Supabase catalog (no secrets returned).
 */
import { NextRequest, NextResponse } from 'next/server'
import { timingSafeEqual } from 'crypto'
import { websiteSupabaseConfigured } from '@/lib/website/supabase-client'
import { websiteCatalogStats } from '@/lib/website/catalog.service'

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

export async function GET(req: NextRequest) {
  if (!checkToken(req)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const configured = websiteSupabaseConfigured()
  if (!configured) {
    return NextResponse.json({
      ok: false,
      configured: false,
      error: 'WEBSITE_SUPABASE_URL or WEBSITE_SUPABASE_SERVICE_ROLE_KEY not set',
    }, { status: 503 })
  }

  try {
    const stats = await websiteCatalogStats()
    const url = process.env.WEBSITE_SUPABASE_URL ?? ''
    const ref = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null
    return NextResponse.json({
      ok: true,
      configured: true,
      projectRef: ref,
      totalProducts: stats.totalProducts,
      totalPublished: stats.totalPublished,
      categories: stats.byCategory.map((c) => ({ slug: c.slug, published: c.published })),
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    return NextResponse.json({
      ok: false,
      configured: true,
      error: err instanceof Error ? err.message : String(err),
    }, { status: 502 })
  }
}
