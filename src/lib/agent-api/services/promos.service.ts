import { getLifestylePromos } from '@/lib/lifestyle/read'
import {
  dispatchCreatePromo,
  dispatchDeactivatePromo,
  dispatchDeletePromo,
  dispatchUpdatePromo,
} from '@/lib/lifestyle/write-dispatch'
import { agentActorPayload } from '@/lib/agent-api/route-handler'

/** GAS promos route — returns empty if not deployed yet. */
export async function listPromos() {
  try {
    const data = await getLifestylePromos()
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
  const result = await dispatchCreatePromo(agentActorPayload(body))
  return { id: String((result as { id?: string; code?: string }).id ?? (result as { code?: string }).code ?? ''), status: 'created', createdAt: new Date().toISOString() }
}

export async function patchPromo(id: string, body: Record<string, unknown>) {
  await dispatchUpdatePromo(agentActorPayload({ id, ...body }))
  return { id, status: 'updated', updatedAt: new Date().toISOString() }
}

export async function deactivatePromo(id: string) {
  await dispatchDeactivatePromo(agentActorPayload({ id }))
  return { id, status: 'deactivated' }
}

export async function deletePromo(id: string) {
  await dispatchDeletePromo(agentActorPayload({ id }))
  return { id, status: 'deleted' }
}
