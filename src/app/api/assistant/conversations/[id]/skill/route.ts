/**
 * SK-3 — the owner's override for which skill runs this chat.
 *
 * He asked to SEE the pinned skill and to be able to change it. Seeing it is the
 * chip; this is changing it. `{ skill: null }` clears the pin, so the next
 * message re-routes from scratch — that is what tapping the chip does.
 *
 * An owner pin is sticky: `resolveSkillPin` never overwrites a pin, and the
 * stored trace records that HE chose it, so a later look at a surprising run can
 * tell "the router picked this" apart from "Boss picked this".
 */
import { type NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { requireAgentEnabled } from '@/agent/lib/guards'
import { isSystemOwner } from '@/lib/roles'
import { setOwnerPin } from '@/agent/lib/skill-engine/pin'

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  const disabled = requireAgentEnabled()
  if (disabled) return disabled

  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET })
  if (!token?.sub) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!isSystemOwner(token)) return Response.json({ error: 'forbidden' }, { status: 403 })

  let body: { skill?: string | null }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'bad_request' }, { status: 400 })
  }

  const skill = typeof body.skill === 'string' && body.skill.trim() ? body.skill.trim() : null

  try {
    await setOwnerPin(params.id, skill)
    return Response.json({ ok: true, skill })
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : 'failed' },
      { status: 500 },
    )
  }
}
