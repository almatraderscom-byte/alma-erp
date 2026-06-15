/**
 * Weekly reflection — distill candidate heuristics from outcomes + decisions.
 * Proposals stay `proposed` until owner approves via playbook tools.
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, isAnthropicConfigured } from '@/agent/config'
import { enforceClaudeOnlyModel } from '@/agent/lib/models/guard'
import { calcAnthropicChatCostUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { PLAYBOOK_DOMAINS } from '@/agent/lib/playbook'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const REFLECTION_SYSTEM = `আপনি ALMA ERP agent-এর সাপ্তাহিক reflection analyst।
শুধু JSON array আউটপুট দিন — markdown/ব্যাখ্যা নয়।
নিয়ম (অবশ্য):
- correlation, causation নয় — প্রতিটি heuristic একটি পরীক্ষার hypotheses হিসেবে লিখুন, প্রমাণিত আইন নয়।
- শুধু বাংলায় heuristic ও evidence লিখুন।
- heuristic ≤ 200 অক্ষর, imperative tone।
- ≥২টি supporting observation না থাকলে কিছু propose করবেন না — [] দিন।
- সর্বোচ্চ ৫টি candidate।
- domain: content | ads | staff | pricing | customer | ops | design
- businessId: ALMA_LIFESTYLE | ALMA_TRADING
- confidence: 1..5`

export type ReflectionCandidate = {
  businessId: string
  domain: string
  heuristic: string
  evidence: string
  confidence: number
}

async function gatherReflectionContext(since: Date) {
  const [outcomes, pendingActions, staffTasks, adNotifs, existingProposed] = await Promise.all([
    db.agentOutcome.findMany({
      where: {
        OR: [{ measuredAt: { gte: since } }, { createdAt: { gte: since } }],
      },
      orderBy: { createdAt: 'desc' },
      take: 40,
      select: {
        type: true,
        subjectName: true,
        suggestion: true,
        result: true,
        learning: true,
        status: true,
        ownerActioned: true,
      },
    }),
    db.agentPendingAction.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, type: true, summary: true },
      take: 60,
    }),
    db.agentStaffTask.findMany({
      where: { createdAt: { gte: since } },
      select: { status: true, type: true, businessId: true },
      take: 200,
    }),
    db.agentNotification.findMany({
      where: {
        createdAt: { gte: since },
        OR: [
          { category: 'report' },
          { title: { contains: 'Ad', mode: 'insensitive' } },
          { title: { contains: 'ads', mode: 'insensitive' } },
        ],
      },
      select: { title: true, message: true, createdAt: true },
      take: 10,
      orderBy: { createdAt: 'desc' },
    }),
    db.agentPlaybook.findMany({
      where: { status: { in: ['proposed', 'active'] }, createdAt: { gte: since } },
      select: { heuristic: true, businessId: true },
    }),
  ])

  const staffByBiz = (biz: string) => {
    const rows = staffTasks.filter((t: { businessId: string }) => t.businessId === biz)
    const total = rows.length
    const done = rows.filter((t: { status: string }) => t.status === 'done').length
    const carried = rows.filter((t: { status: string }) => t.status === 'carried').length
    return { total, done, carried, completionPct: total > 0 ? Math.round((done / total) * 100) : null }
  }

  const approvals = {
    approved: pendingActions.filter((a: { status: string }) =>
      ['approved', 'executed', 'approved_queued'].includes(a.status),
    ).length,
    rejected: pendingActions.filter((a: { status: string }) => a.status === 'rejected').length,
    pending: pendingActions.filter((a: { status: string }) => a.status === 'pending').length,
    byType: pendingActions.reduce((acc: Record<string, number>, a: { type: string }) => {
      acc[a.type] = (acc[a.type] ?? 0) + 1
      return acc
    }, {}),
  }

  return {
    periodDays: 7,
    outcomes,
    approvals,
    staff: {
      ALMA_LIFESTYLE: staffByBiz('ALMA_LIFESTYLE'),
      ALMA_TRADING: staffByBiz('ALMA_TRADING'),
    },
    adDigests: adNotifs.map((n: { title: string; message: string }) => ({
      title: n.title,
      excerpt: String(n.message).slice(0, 400),
    })),
    skipHeuristics: existingProposed.map((p: { heuristic: string }) => p.heuristic),
  }
}

function parseCandidates(raw: string): ReflectionCandidate[] {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  try {
    const arr = JSON.parse(jsonMatch[0]) as unknown[]
    if (!Array.isArray(arr)) return []
    const out: ReflectionCandidate[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const businessId = o.businessId === 'ALMA_TRADING' ? 'ALMA_TRADING' : 'ALMA_LIFESTYLE'
      const domain = String(o.domain ?? '').toLowerCase()
      if (!PLAYBOOK_DOMAINS.includes(domain as typeof PLAYBOOK_DOMAINS[number])) continue
      const heuristic = String(o.heuristic ?? '').trim().slice(0, 200)
      const evidence = String(o.evidence ?? '').trim()
      const confidence = Math.min(5, Math.max(1, parseInt(String(o.confidence ?? 2), 10) || 2))
      if (!heuristic || !evidence) continue
      out.push({ businessId, domain, heuristic, evidence, confidence })
    }
    return out.slice(0, 5)
  } catch {
    return []
  }
}

async function proposeHeuristics(context: Awaited<ReturnType<typeof gatherReflectionContext>>): Promise<ReflectionCandidate[]> {
  if (!isAnthropicConfigured()) return []

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const factsJson = JSON.stringify(context, null, 0).slice(0, 12000)

  const res = await client.messages.create({
    model: enforceClaudeOnlyModel(),
    max_tokens: 1200,
    system: [{ type: 'text', text: REFLECTION_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content:
        'গত ৭ দিনের observation থেকে ≤৫টি candidate heuristic JSON array দিন।\n' +
        'Format: [{"businessId":"ALMA_LIFESTYLE","domain":"content","heuristic":"...","evidence":"...","confidence":3}]\n' +
        'ডেটা যথেষ্ট না হলে [] দিন।\n\n' +
        `DATA:\n${factsJson}`,
    }],
  })

  const block = res.content.find((b) => b.type === 'text')
  const text = block && block.type === 'text' ? block.text : ''

  void logCost({
    provider: 'anthropic',
    kind: 'chat',
    units: {
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
      model: enforceClaudeOnlyModel(),
      purpose: 'weekly_reflection',
    },
    costUsd: calcAnthropicChatCostUsd({
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    }),
    dedupKey: `reflection:${todayYmdDhaka()}`,
  })

  return parseCandidates(text)
}

function buildOwnerSummary(items: Array<{ id: string; domain: string; heuristic: string; evidence: string; businessId: string }>): string {
  const lines = [
    '🧠 *সাপ্তাহিক reflection — playbook proposals*',
    '',
    'আমি গত সপ্তাহ থেকে এই শিক্ষাগুলো লক্ষ্য করেছি — কোনগুলো নিয়ম হিসেবে রাখব?',
    '(correlation, causation নয় — hypotheses)',
    '',
  ]
  items.forEach((item, i) => {
    lines.push(`${i + 1}. [${item.businessId}/${item.domain}] ${item.heuristic}`)
    lines.push(`   _প্রমাণ:_ ${item.evidence.slice(0, 120)}`)
    lines.push(`   → approve_playbook(id="${item.id}") বা reject_playbook(id="${item.id}")`)
    lines.push('')
  })
  lines.push('Agent chat-এ list_playbook দিয়ে review করতে পারেন।')
  return lines.join('\n')
}

export async function runWeeklyReflection(): Promise<{
  proposed: number
  skipped: boolean
  playbookIds: string[]
}> {
  const since = new Date(Date.now() - 7 * 86_400_000)
  const context = await gatherReflectionContext(since)
  const candidates = await proposeHeuristics(context)

  if (!candidates.length) {
    console.log('[reflection] no strong candidates — []')
    return { proposed: 0, skipped: true, playbookIds: [] }
  }

  const skipSet = new Set(context.skipHeuristics.map((h: string) => h.toLowerCase()))
  const inserted: Array<{ id: string; domain: string; heuristic: string; evidence: string; businessId: string }> = []

  for (const c of candidates) {
    if (skipSet.has(c.heuristic.toLowerCase())) continue
    const row = await db.agentPlaybook.create({
      data: {
        businessId: c.businessId,
        domain: c.domain,
        heuristic: c.heuristic,
        evidence: c.evidence,
        confidence: c.confidence,
        status: 'proposed',
      },
    })
    inserted.push({
      id: row.id,
      domain: row.domain,
      heuristic: row.heuristic,
      evidence: row.evidence,
      businessId: row.businessId,
    })
    skipSet.add(c.heuristic.toLowerCase())
  }

  if (!inserted.length) {
    return { proposed: 0, skipped: true, playbookIds: [] }
  }

  const summary = buildOwnerSummary(inserted)
  const pendingAction = await db.agentPendingAction.create({
    data: {
      type: 'playbook_review',
      payload: {
        playbookIds: inserted.map((i) => i.id),
        items: inserted,
        weekEnd: todayYmdDhaka(),
      },
      summary,
      status: 'pending',
      businessId: 'ALMA_LIFESTYLE',
    },
  })

  await notifyOwner({
    tier: 2,
    title: 'Playbook proposals — review করুন',
    message: summary.replace(/\*/g, ''),
    category: 'report',
  })

  void sendOwnerText(summary).catch(() => {})

  console.log(`[reflection] proposed=${inserted.length} pendingAction=${pendingAction.id}`)
  return { proposed: inserted.length, skipped: false, playbookIds: inserted.map((i) => i.id) }
}
