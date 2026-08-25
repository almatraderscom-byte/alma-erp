/**
 * Runnable-head fallback selection (PR #854).
 *
 * ONE definition of "a head this deployment can actually run", shared by:
 *  - run-owner-turn's in-turn missing-key fallback (a restored pin whose
 *    provider has no key here switches to this candidate with a visible note);
 *  - the chat route's internal preflight (a fresh Telegram call whose default
 *    head is disabled/keyless must not 503 when the runner would fall back to
 *    a runnable head anyway — Codex P1 #854 r9).
 *
 * A candidate must be: head-pickable, tool-capable, enabled in the owner's
 * Monitor map, key-configured for its provider, not protocol-quarantined, and
 * (for Anthropic) allowed per model under ANTHROPIC_HEAD_DOWN/Monitor.
 * Preference order: default head, heavy head, then registry order.
 */
import { getModel, MODEL_REGISTRY } from '@/agent/lib/models/registry'
import { isProviderKeyConfigured } from '@/agent/lib/guards'
import { protocolConformanceFor } from '@/agent/lib/models/provider-protocol'
import { getModelEnabledMap, isModelEnabledSync, isAnthropicAllowed } from '@/agent/lib/models/model-enabled'

export async function findRunnableHeadFallback(
  excludeModelId?: string | null,
): Promise<string | null> {
  const { getDefaultHeadModelId } = await import('@/agent/lib/models/routing-config')
  const { heavyHeadModelId } = await import('@/agent/lib/models/head-router')
  const enabledMap = await getModelEnabledMap()
  const candidates = [
    await getDefaultHeadModelId(),
    heavyHeadModelId(),
    ...MODEL_REGISTRY.filter((entry) => entry.headPickable !== false).map((entry) => entry.id),
  ]
  for (const id of candidates) {
    try {
      const candidate = getModel(id)
      if (excludeModelId && id === excludeModelId) continue
      if (candidate.headPickable === false) continue
      // A head fallback must be able to DRIVE tools — a vision-only model
      // would silently turn an ERP action turn chat-only (r6 P2).
      if (candidate.supportsTools === false) continue
      if (!isModelEnabledSync(id, enabledMap)) continue
      if (!isProviderKeyConfigured(candidate.provider)) continue
      if (protocolConformanceFor(candidate).state === 'quarantined') continue
      // ANTHROPIC_HEAD_DOWN (default ON) defines Claude as unavailable even
      // with a key present — and the check is PER MODEL (r6 P1 + r7 P2).
      if (candidate.provider === 'anthropic' && !(await isAnthropicAllowed(candidate.id))) continue
      return id
    } catch {
      continue
    }
  }
  return null
}
