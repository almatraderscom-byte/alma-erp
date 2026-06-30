/**
 * Staff WhatsApp opt-in status for the home-page gate (step 2).
 *
 * Returns whether the gate is ON and whether THIS logged-in user has opted in
 * today. Fails OPEN on every path (auth miss / error → gateEnabled:false,
 * optedInToday:true) so a glitch can never lock a staff member out of the ERP.
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { waStaffGateEnabled, hasOptedInToday } from '@/agent/lib/wa/optin'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  try {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    const userId = token?.sub
    if (!userId) return Response.json({ gateEnabled: false, optedInToday: true })

    const gateEnabled = await waStaffGateEnabled()
    if (!gateEnabled) return Response.json({ gateEnabled: false, optedInToday: true })

    const optedInToday = await hasOptedInToday(userId)
    return Response.json({ gateEnabled: true, optedInToday })
  } catch {
    // Fail-open: any error must NOT lock the user out.
    return Response.json({ gateEnabled: false, optedInToday: true })
  }
}
