import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireRoles } from '@/lib/api-guards'

export const dynamic = 'force-dynamic'

function maskDbHint(raw: string | undefined): string {
  const u = String(raw || '').trim()
  if (!u) return '(not set)'
  try {
    const parsed = new URL(u.replace(/^postgresql:/i, 'http:'))
    const host = parsed.hostname || '?'
    const db = parsed.pathname.replace(/^\//, '') || 'postgres'
    return `${host} · db ${db}`
  } catch {
    return '(invalid URL format)'
  }
}

function isPlaceholder(url: string): boolean {
  return /REPLACE_PROJECT_REF|REPLACE_PASSWORD/i.test(url)
}

/** Diagnostics for Settings → Database (SUPER_ADMIN / ADMIN / HR only). */
export async function GET(_req: NextRequest) {
  const denied = await requireRoles(_req, ['SUPER_ADMIN', 'ADMIN', 'HR'])
  if (denied) return denied

  const rawUrl = process.env.DATABASE_URL
  const configured = Boolean(rawUrl?.trim())
  const placeholder = configured && isPlaceholder(String(rawUrl))

  let postgresReachable = false
  let prismaWorks = false
  let userCount: number | null = null
  let error: string | undefined

  const nextAuthSecret = Boolean(process.env.NEXTAUTH_SECRET?.trim())
  const nextAuthUrl = process.env.NEXTAUTH_URL?.trim() || null

  if (!configured) {
    error = 'DATABASE_URL is missing. Add it to .env.local and .env — see docs/SUPABASE_POSTGRES_SETUP.md.'
  } else if (placeholder) {
    error =
      'DATABASE_URL still contains REPLACE_PROJECT_REF or REPLACE_PASSWORD. Paste your Supabase URI from the dashboard.'
  } else {
    try {
      await prisma.$queryRaw`SELECT 1`
      postgresReachable = true
      prismaWorks = true
      userCount = await prisma.user.count()
    } catch (e) {
      error = (e as Error).message || 'Database connection failed'
    }
  }

  return NextResponse.json({
    databaseUrlConfigured: configured && !placeholder,
    databaseUrlHint: maskDbHint(rawUrl),
    postgresReachable,
    prismaWorks,
    userRowCount: userCount,
    nextAuthSecretConfigured: nextAuthSecret,
    nextAuthUrl,
    error,
  })
}
