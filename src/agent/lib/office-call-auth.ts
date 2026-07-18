import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import { businessAllowed } from '@/lib/business-access'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export type OfficeCallIdentity =
  | { ok: true; userId: string; businessId: string; role: 'owner' | 'staff' }
  | { ok: false; error: 'unauthorized' | 'forbidden'; code: 401 | 403 }

export async function identifyOfficeCallRequest(req: NextRequest): Promise<OfficeCallIdentity> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return { ok: false, error: 'unauthorized', code: 401 }
  if (isSystemOwner(token)) {
    const businessId = req.nextUrl.searchParams.get('businessId')?.trim() || DEFAULT_BUSINESS
    if (!businessAllowed(token.businessAccess as string | undefined, businessId)) {
      return { ok: false, error: 'forbidden', code: 403 }
    }
    return {
      ok: true,
      userId: token.sub,
      businessId,
      role: 'owner',
    }
  }
  const staff = await resolveSessionStaff(token.sub)
  if (!staff) return { ok: false, error: 'forbidden', code: 403 }
  return { ok: true, userId: token.sub, businessId: staff.businessId, role: 'staff' }
}
