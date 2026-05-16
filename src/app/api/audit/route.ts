import { NextRequest, NextResponse } from 'next/server'
import { serverGet } from '@/lib/server-api'
import { listPostgresAuditFallback } from '@/lib/audit-fallback'
import { logEvent } from '@/lib/logger'

export async function GET(req: NextRequest) {
  const p = Object.fromEntries(new URL(req.url).searchParams) as Record<string, string>
  try {
    const data = await serverGet<{ audit?: unknown[]; total?: number }>('audit_log', p, 0)
    if (!data.audit?.length) {
      const fallback = await listPostgresAuditFallback(p)
      if (fallback.audit.length) {
        return NextResponse.json(
          { ...fallback, gasTotal: data.total ?? 0 },
          { headers: { 'Cache-Control': 'private, no-store' } },
        )
      }
    }
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (e) {
    logEvent('warn', 'audit_log_gas_unavailable', { error: (e as Error).message })
    try {
      const fallback = await listPostgresAuditFallback(p)
      return NextResponse.json(fallback, { headers: { 'Cache-Control': 'private, no-store' } })
    } catch (fallbackError) {
      return NextResponse.json(
        { error: (fallbackError as Error).message, gasError: (e as Error).message },
        { status: 500 },
      )
    }
  }
}
