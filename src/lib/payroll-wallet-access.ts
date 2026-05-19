import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { walletBusinessFilter, isWalletAdmin } from '@/lib/payroll-wallet'
import { isSystemOwner, normalizeAlmaRole } from '@/lib/roles'
import { resolveMyDeskProfile } from '@/lib/profile-resolution'

export async function getWalletContext(req: NextRequest, requestedBusinessId?: string | null) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const role = normalizeAlmaRole(token.role as string)
  const systemOwner = isSystemOwner(role)
  const businessIds = walletBusinessFilter(token.businessAccess, requestedBusinessId)
  if (requestedBusinessId && !businessIds.includes(requestedBusinessId as never)) {
    return { error: NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 }) }
  }
  const tokenEmployeeId = String(token.employeeIdGas || '').trim()
  // Always resolve desk profile for staff — trading employees often store HR id only on TradingEmployeeProfile.
  const profile = !systemOwner ? await resolveMyDeskProfile(token.sub, businessIds[0]) : null
  const employeeId = systemOwner ? '' : (tokenEmployeeId || String(profile?.employeeIdGas || '').trim())

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
