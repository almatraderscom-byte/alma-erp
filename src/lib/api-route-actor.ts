import type { NextRequest } from 'next/server'

/** Merge actor identity from browser headers into GAS POST payloads for audit trails. */
export function withActorPayload(req: NextRequest, payload: Record<string, unknown>): Record<string, unknown> {
  const actor =
    req.headers.get('x-alma-actor')?.trim().slice(0, 120) ||
    String(payload.actor ?? 'Web').slice(0, 120)
  const actor_role =
    req.headers.get('x-alma-role')?.trim().slice(0, 48) ||
    String(payload.actor_role ?? 'SUPER_ADMIN').slice(0, 48)
  return { ...payload, actor, actor_role }
}
