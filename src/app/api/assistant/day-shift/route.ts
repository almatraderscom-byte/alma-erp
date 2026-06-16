/**
 * GET /api/assistant/day-shift — today's office shift status (owner session).
 */
import { type NextRequest, NextResponse } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { getDayShiftToday } from '@/agent/lib/day-shift'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const data = await getDayShiftToday()
  return NextResponse.json(data)
}
