import { getToken } from 'next-auth/jwt'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import type { UserRole } from '@prisma/client'
import type { AlmaRole } from '@/lib/roles'
import { normalizeAlmaRole } from '@/lib/roles'
import { businessAllowed } from '@/lib/business-access'

function isAuthBuildPhase() {
  return (
    process.env.NEXT_PHASE === 'phase-production-build' ||
    process.env.NEXT_PHASE === 'phase-export'
  )
}

export async function getJwt(req: NextRequest) {
  const secret = process.env.NEXTAUTH_SECRET?.trim()
  if (!secret) {
    // Next.js may execute route handlers during `next build` without runtime env.
    if (isAuthBuildPhase()) return null
    throw new Error('NEXTAUTH_SECRET is not configured')
  }
  return getToken({ req, secret })
}

/** Block read-only VIEWER from mutating routes. */
export async function forbidViewerWrite(req: NextRequest) {
  const token = await getJwt(req)
  const role = normalizeAlmaRole(token?.role as string)
  if (role === 'VIEWER') {
    return NextResponse.json({ error: 'Read-only users cannot modify data.' }, { status: 403 })
  }
  return null
}

export async function requireRoles(req: NextRequest, allowed: AlmaRole[]) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const role = normalizeAlmaRole(token.role as string)
  if (!allowed.includes(role)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null as null
}

/** Require NextAuth JWT roles Prisma enum-compatible */
export async function requirePrismaRoles(req: NextRequest, allowed: UserRole[]) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const r = token.role as UserRole | undefined
  if (!r || !allowed.includes(r)) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }
  return null as null
}

export async function validateMutationBusiness(req: NextRequest, businessId: string | undefined | null) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const biz = String(businessId || 'ALMA_LIFESTYLE')
  if (!businessAllowed(token.businessAccess as string, biz)) {
    return NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 })
  }
  return null as null
}
