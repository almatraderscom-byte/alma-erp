import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { walletBusinessFilter, isWalletAdmin } from '@/lib/payroll-wallet'
import { isSystemOwner, normalizeAlmaRole } from '@/lib/roles'
import { resolveMyDeskProfile } from '@/lib/profile-resolution'
import { isAllBusinessesScope } from '@/lib/attendance-business'

export async function getWalletContext(req: NextRequest, requestedBusinessId?: string | null) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const role = normalizeAlmaRole(token.role as string)
  const systemOwner = isSystemOwner(role)
  const businessIds = walletBusinessFilter(token.businessAccess, requestedBusinessId)
  if (
    requestedBusinessId
    && !isAllBusinessesScope(requestedBusinessId)
    && !businessIds.includes(requestedBusinessId as never)
  ) {
    return { error: NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 }) }
  }
  const tokenEmployeeId = String(token.employeeIdGas || '').trim()
  let employeeId = systemOwner ? '' : tokenEmployeeId
  // Only hit DB when JWT lacks employee id (trading staff often store HR id on TradingEmployeeProfile).
  if (!systemOwner && !employeeId) {
    const profile = await resolveMyDeskProfile(token.sub, businessIds[0])
    employeeId = String(profile?.employeeIdGas || '').trim()
  }

  return {
    token,
    userId: token.sub,
    role,
    isSystemOwner: systemOwner,
    isAdmin: isWalletAdmin(role),
    employeeId,
    businessIds,
  }
}

export function forbidden(message = 'Forbidden') {
  return NextResponse.json({ error: message }, { status: 403 })
}
