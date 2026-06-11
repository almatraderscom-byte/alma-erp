import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { timingSafeEqual } from 'crypto'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { prisma } from '@/lib/prisma'

export const runtime = 'nodejs'

function verifyInternalToken(provided: string): boolean {
  const expected = process.env.AGENT_INTERNAL_TOKEN ?? ''
  if (!expected || !provided) return false
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch { return false }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const authHeader = req.headers.get('authorization') ?? ''
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : ''
  if (!verifyInternalToken(bearerToken)) {
    const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
    if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })
  }

  let body: { option?: string }
  try { body = await req.json() } catch { return Response.json({ error: 'invalid_json' }, { status: 400 }) }

  const option = typeof body.option === 'string' ? body.option.trim() : ''
  if (!option) return Response.json({ error: 'option_required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any
  const card = await db.agentAskCard.findUnique({ where: { id: params.id } })
  if (!card) return Response.json({ error: 'not_found' }, { status: 404 })
  if (card.status !== 'pending') {
    return Response.json({ error: 'already_answered', selectedOption: card.selectedOption }, { status: 409 })
  }

  const options: string[] = JSON.parse(card.options)
  if (!options.includes(option)) {
    return Response.json({ error: 'invalid_option' }, { status: 400 })
  }

  await db.agentAskCard.update({
    where: { id: params.id },
    data: { status: 'answered', selectedOption: option },
  })

  return Response.json({ success: true, option })
}
