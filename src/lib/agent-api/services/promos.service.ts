import { serverGet, serverPost } from '@/lib/server-api'
import { agentActorPayload } from '@/lib/agent-api/route-handler'

type PromoRow = {
  id?: string
  code?: string
  discount_pct?: number
  discount_amount?: number
  active?: boolean
  expires_at?: string
  usage_count?: number
}

/** GAS promos route — returns empty if not deployed yet. */
export async function listPromos() {
  try {
    const data = await serverGet<{ promos?: PromoRow[] }>('promos', {}, 0)
    const promos = (data.promos ?? []).map((p, i) => ({
      id: String(p.id ?? p.code ?? `promo_${i}`),
      code: String(p.code ?? ''),
      discountPct: p.discount_pct ?? null,
      discountAmount: p.discount_amount ?? null,
      active: p.active !== false,
      expiresAt: p.expires_at ?? null,
      usageCount: Number(p.usage_count ?? 0),
    }))
    return { promos, meta: { count: promos.length } }
  } catch {
    return { promos: [], meta: { count: 0 } }
  }
}

export async function createPromo(body: Record<string, unknown>) {
  const result = await serverPost<{ id?: string; code?: string }>(
    'create_promo',
    agentActorPayload(body),
  )
  return { id: String(result.id ?? result.code ?? ''), status: 'created', createdAt: new Date().toISOString() }
}

export async function patchPromo(id: string, body: Record<string, unknown>) {
  await serverPost('update_promo', agentActorPayload({ id, ...body }))
  return { id, status: 'updated', updatedAt: new Date().toISOString() }
}

export async function deactivatePromo(id: string) {
  await serverPost('deactivate_promo', agentActorPayload({ id }))
  return { id, status: 'deactivated' }
}

export async function deletePromo(id: string) {
  await serverPost('delete_promo', agentActorPayload({ id }))
  return { id, status: 'deleted' }
}
