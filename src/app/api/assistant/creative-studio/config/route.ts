import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { isFashnConfigured } from '@/lib/fashn/client'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  return Response.json({
    fashnConfigured: isFashnConfigured(),
    geminiConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    veoConfigured: Boolean(process.env.GEMINI_API_KEY?.trim()),
    organization: 'Alma Traders',
  })
}
