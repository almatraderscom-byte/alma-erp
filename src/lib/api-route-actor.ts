import type { NextRequest } from 'next/server'
import { getToken } from 'next-auth/jwt'
import { normalizeAlmaRole } from '@/lib/roles'

/** Merge authenticated user into GAS POST payloads for audit trails (never trust client headers alone). */
export async function mergeActorPayload(req: NextRequest, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secret = process.env.NEXTAUTH_SECRET
  let actor = req.headers.get('x-alma-actor')?.trim().slice(0, 120) || ''
  let actor_role = req.headers.get('x-alma-role')?.trim().slice(0, 48) || ''
  let actor_user_id = ''

  if (secret) {
    try {
      const token = await getToken({ req, secret })
      if (token?.sub) {
        actor_user_id = String(token.sub)
        actor = String(token.name || token.email || actor || 'User').slice(0, 120)
        actor_role = normalizeAlmaRole(token.role as string).slice(0, 48)
      }
    } catch {
      /* ignore */
    }
  }

  return {
    ...payload,
    actor: actor || String(payload.actor ?? 'Web').slice(0, 120),
    actor_role: actor_role || String(payload.actor_role ?? 'VIEWER').slice(0, 48),
    actor_user_id: actor_user_id || String(payload.actor_user_id ?? ''),
  }
}
