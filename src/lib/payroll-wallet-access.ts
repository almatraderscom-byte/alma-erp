import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { getJwt } from '@/lib/api-guards'
import { walletBusinessFilter, isWalletAdmin } from '@/lib/payroll-wallet'
import { normalizeAlmaRole } from '@/lib/roles'

export async function getWalletContext(req: NextRequest, requestedBusinessId?: string | null) {
  const token = await getJwt(req)
  if (!token?.sub) {
    return { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }

  const role = normalizeAlmaRole(token.role as string)
  const businessIds = walletBusinessFilter(token.businessAccess, requestedBusinessId)
  if (requestedBusinessId && !businessIds.includes(requestedBusinessId as never)) {
    return { error: NextResponse.json({ error: 'Business not permitted for this user.' }, { status: 403 }) }
  }

  return {
    token,
    userId: token.sub,
    role,
    isAdmin: isWalletAdmin(role),
    employeeId: String(token.employeeIdGas || '').trim(),
    businessIds,
  }
}

export function forbidden(message = 'Forbidden') {
  return NextResponse.json({ error: message }, { status: 403 })
}
