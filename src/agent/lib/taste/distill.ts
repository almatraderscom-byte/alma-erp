/**
 * Distill taste_signal rows → design-domain playbook rules (weekly).
 */
import Anthropic from '@anthropic-ai/sdk'
import { AGENT_MODEL, isAnthropicConfigured } from '@/agent/config'
import { prisma } from '@/lib/prisma'
import { logCost } from '@/agent/lib/cost-events'
import { calcAnthropicChatCostUsd } from '@/agent/lib/pricing'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const DISTILL_SYSTEM = `You distill owner keep/reject taste signals into ONE design playbook rule for ALMA fashion creatives.
Output JSON only: {"heuristic":"Bangla imperative rule ≤200 chars","confidence":1-5}
If insufficient pattern, output {"heuristic":"","confidence":0}.
Focus on composition, lighting, background, crop, mood — not product SKUs.`

export async function runTasteDistill(opts?: { days?: number }): Promise<{
  created: number
  skipped: boolean
  heuristic?: string
}> {
  const days = opts?.days ?? 14
  const since = new Date(Date.now() - days * 86400000)

  const signals = await db.agentTasteSignal.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'desc' },
    take: 40,
  })

  if (signals.length < 2) {
    return { created: 0, skipped: true }
  }

  const keeps = signals.filter((s: { verdict: string }) => s.verdict === 'keep')
  const rejects = signals.filter((s: { verdict: string }) => s.verdict === 'reject')

  if (!isAnthropicConfigured()) {
    return { created: 0, skipped: true }
  }

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const res = await client.messages.create({
    model: AGENT_MODEL || 'claude-sonnet-4-6',
    max_tokens: 400,
    system: DISTILL_SYSTEM,
    messages: [{
      role: 'user',
      content:
        `Keep signals (${keeps.length}):\n${JSON.stringify(keeps.map((k: { attrs: unknown }) => k.attrs).slice(0, 8))}\n\n` +
        `Reject signals (${rejects.length}):\n${JSON.stringify(rejects.map((r: { attrs: unknown }) => r.attrs).slice(0, 8))}`,
    }],
  })

  void logCost({
    provider: 'anthropic',
    kind: 'chat',
    units: { purpose: 'taste_distill', signalCount: signals.length },
    costUsd: calcAnthropicChatCostUsd(res.usage),
    dedupKey: `taste_distill:${since.toISOString().slice(0, 10)}`,
  })

  const block = res.content.find((b) => b.type === 'text')
  const raw = block && block.type === 'text' ? block.text.trim() : ''
  const match = raw.match(/\{[\s\S]*\}/)
  if (!match) return { created: 0, skipped: true }

  const parsed = JSON.parse(match[0]) as { heuristic?: string; confidence?: number }
  const heuristic = String(parsed.heuristic ?? '').trim()
  const confidence = Math.min(5, Math.max(1, Number(parsed.confidence ?? 3)))
  if (!heuristic || heuristic.length < 10) return { created: 0, skipped: true }

  const dup = await db.agentPlaybook.findFirst({
    where: { businessId: 'ALMA_LIFESTYLE', domain: 'design', status: 'active', heuristic: { contains: heuristic.slice(0, 40) } },
  })
  if (dup) return { created: 0, skipped: true, heuristic }

  await db.agentPlaybook.create({
    data: {
      businessId: 'ALMA_LIFESTYLE',
      domain: 'design',
      heuristic,
      evidence: JSON.stringify({
        source: 'taste_distill',
        signalCount: signals.length,
        keepCount: keeps.length,
        rejectCount: rejects.length,
        distilledAt: new Date().toISOString(),
      }),
      confidence,
      status: 'proposed',
      reviewedAt: null,
    },
  })

  return { created: 1, skipped: false, heuristic }
}

export async function getDesignPlaybookLines(businessId = 'ALMA_LIFESTYLE'): Promise<string[]> {
  const rows = await db.agentPlaybook.findMany({
    where: { businessId, domain: 'design', status: 'active' },
    orderBy: [{ confidence: 'desc' }, { timesApplied: 'desc' }],
    take: 10,
    select: { heuristic: true },
  })
  return rows.map((r: { heuristic: string }) => r.heuristic)
}
