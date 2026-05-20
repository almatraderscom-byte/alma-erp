import type { NextRequest } from 'next/server'
import type { NextResponse } from 'next/server'
import { getJwt, requireRoles, forbidViewerWrite, validateMutationBusiness } from '@/lib/api-guards'
import { getWalletContext } from '@/lib/payroll-wallet-access'
import { apiFailure } from '@/lib/safe-api-response'
import type { AlmaRole } from '@/lib/roles'

export { withApiRoute, apiDataSuccess, apiFailure, apiSuccess } from '@/lib/core/safe-api'

export async function parseJsonBody<T extends Record<string, unknown>>(
  req: NextRequest,
): Promise<T> {
  return (await req.json().catch(() => ({}))) as T
}

export async function requireJwt(
  req: NextRequest,
): Promise<{ ok: true; token: NonNullable<Awaited<ReturnType<typeof getJwt>>> } | { ok: false; response: NextResponse }> {
  const token = await getJwt(req)
  if (!token?.sub) {
    return { ok: false, response: apiFailure('unauthorized', 'Unauthorized', { status: 401 }) }
  }
  return { ok: true, token }
}

export async function requireJwtRoles(
  req: NextRequest,
  roles: AlmaRole[],
): Promise<{ ok: true; token: NonNullable<Awaited<ReturnType<typeof getJwt>>> } | { ok: false; response: NextResponse }> {
  const denied = await requireRoles(req, roles)
  if (denied) return { ok: false, response: denied }
  const token = await getJwt(req)
  if (!token?.sub) return { ok: false, response: apiFailure('unauthorized', 'Unauthorized', { status: 401 }) }
  return { ok: true, token }
}

type WalletCtx = Exclude<Awaited<ReturnType<typeof getWalletContext>>, { error: unknown }>

export async function requireWalletContext(
  req: NextRequest,
  businessId?: string | null,
): Promise<{ ok: true; ctx: WalletCtx } | { ok: false; response: NextResponse }> {
  const ctx = await getWalletContext(req, businessId)
  if ('error' in ctx && ctx.error) return { ok: false as const, response: ctx.error }
  return { ok: true as const, ctx: ctx as WalletCtx }
}

export async function guardViewerWrite(req: NextRequest) {
  const denied = await forbidViewerWrite(req)
  if (denied) return { ok: false as const, response: denied }
  return { ok: true as const }
}

export async function guardBusinessMutation(req: NextRequest, businessId: string | null | undefined) {
  const denied = await validateMutationBusiness(req, businessId)
  if (denied) return { ok: false as const, response: denied }
  return { ok: true as const }
}
