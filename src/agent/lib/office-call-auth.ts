import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { isSystemOwner } from '@/lib/roles'
import { resolveSessionStaff } from '@/agent/lib/office-staff'
import { businessAllowed } from '@/lib/business-access'
import { callIdFromAgoraChannel } from '@/agent/lib/office-call-observability'

const DEFAULT_BUSINESS = 'ALMA_LIFESTYLE'

export type OfficeCallIdentity =
  | { ok: true; userId: string; businessId: string; role: 'owner' | 'staff' }
  | { ok: false; error: 'unauthorized' | 'forbidden'; code: 401 | 403 }

export type OfficeAgoraGrant =
  | { ok: true; kind: 'live'; rtcRole: 'publisher' | 'subscriber'; callId: null }
  | { ok: true; kind: 'call'; rtcRole: 'publisher'; callId: string }
  | { ok: false; error: 'invalid_call_channel' }

/**
 * The shared walkie-talkie channel is business-bound and owner-publish only.
 * Direct call channels stay publisher-capable but are participant-authorized by
 * the route after this structural channel decision.
 */
export function decideOfficeAgoraGrant(args: {
  channel: string
  expectedLiveChannel: string
  identityRole: 'owner' | 'staff'
}): OfficeAgoraGrant {
  if (args.channel === args.expectedLiveChannel) {
    return {
      ok: true,
      kind: 'live',
      rtcRole: args.identityRole === 'owner' ? 'publisher' : 'subscriber',
      callId: null,
    }
  }
  const callId = callIdFromAgoraChannel(args.channel)
  if (!callId) return { ok: false, error: 'invalid_call_channel' }
  return { ok: true, kind: 'call', rtcRole: 'publisher', callId }
}

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
