/**
 * Daily cross-domain strategist — proposes owner-gated high-leverage moves.
 * Propose-only; never auto-executes.
 */
import Anthropic from '@anthropic-ai/sdk'
import { prisma } from '@/lib/prisma'
import { AGENT_MODEL, isAnthropicConfigured } from '@/agent/config'
import { enforceClaudeOnlyModel } from '@/agent/lib/models/guard'
import { calcAnthropicChatCostUsd } from '@/agent/lib/pricing'
import { logCost } from '@/agent/lib/cost-events'
import { notifyOwner } from '@/agent/lib/notify-owner'
import { sendOwnerText } from '@/agent/lib/telegram-owner-notify'
import { getActivePlaybook } from '@/agent/lib/playbook'
import { retrieveRelevantMemories } from '@/agent/lib/agent-memory'
import { eventsInLeadWindow, upcomingEvents } from '@/agent/lib/retail-calendar'
import { buildStrategistDataBundle } from '@/lib/advisor-data-bundle'
import { buildOwnerBriefingData } from '@/agent/lib/owner-briefing-data'
import { todayYmdDhaka } from '@/lib/agent-api/dhaka-date'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

const STRATEGIST_SYSTEM = `আপনি ALMA Lifestyle-এর senior cross-domain business strategist (Dhaka Islamic modest fashion reseller)।
শুধু JSON array আউটপুট — markdown নয়।

প্রতিটি proposed move:
{ "title", "trigger", "rationale", "expected_impact", "first_action", "domain", "domains": ["inventory","calendar"], "confidence": 1..5 }

LOAD-BEARING RULES:
- সর্বোচ্চ ৩টি move। genuinely high-leverage না হলে [] দিন — noise নিষিদ্ধ।
- প্রতিটি move অবশ্যই ≥২টি domain সংযুক্ত করবে (inventory+calendar, ads+content, staff+season ইত্যাদি) — এক domain = reject করুন, propose করবেন না।
- daily report/briefing-এ যা already covered (generic sales summary, pending orders count) — skip করুন।
- NON-OBVIOUS, time-sensitive, cross-domain moves only।
- correlation ≠ causation; assumptions স্পষ্ট; demand invent করবেন না।
- first_action = owner-approved পরবর্তী concrete step (add_owner_todo / content prep / stock check — execute নয়)।
- Bangla title/rationale/trigger/expected_impact/first_action।`

export type StrategistMove = {
  title: string
  trigger: string
  rationale: string
  expected_impact: string
  first_action: string
  domain: string
  domains?: string[]
  confidence: number
}

async function gatherStrategistContext() {
  const [dataBundle, briefing, playbook, memories, calendarUpcoming, calendarLead] = await Promise.all([
    buildStrategistDataBundle(),
    buildOwnerBriefingData().catch(() => null),
    getActivePlaybook('ALMA_LIFESTYLE'),
    retrieveRelevantMemories(
      'cross-domain strategy inventory content ads calendar seasonal staff bundles',
      false,
      'ALMA_LIFESTYLE',
    ),
    Promise.resolve(upcomingEvents()),
    Promise.resolve(eventsInLeadWindow()),
  ])

  const briefingCompact = briefing
    ? {
        pendingOrders: briefing.pendingOrders,
        csWaiting: briefing.csWaiting,
        adsDigest: briefing.adsDigest
          ? { anomalies: briefing.adsDigest.anomalies?.slice(0, 3) }
          : null,
        topIssues: briefing.decisions?.slice(0, 4),
        marketingSeasons: briefing.marketingSeasons?.slice(0, 3),
      }
    : null

  return {
    date: todayYmdDhaka(),
    dataBundle,
    briefing: briefingCompact,
    activePlaybook: playbook,
    relevantMemories: memories.map((m) => ({ scope: m.scope, content: m.content, score: m.score })),
    calendar: { upcoming: calendarUpcoming, inLeadWindow: calendarLead },
  }
}

function parseMoves(raw: string): StrategistMove[] {
  const trimmed = raw.trim()
  const jsonMatch = trimmed.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return []
  try {
    const arr = JSON.parse(jsonMatch[0]) as unknown[]
    if (!Array.isArray(arr)) return []
    const out: StrategistMove[] = []
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue
      const o = item as Record<string, unknown>
      const title = String(o.title ?? '').trim()
      const trigger = String(o.trigger ?? '').trim()
      const rationale = String(o.rationale ?? '').trim()
      const expected_impact = String(o.expected_impact ?? '').trim()
      const first_action = String(o.first_action ?? '').trim()
      const domain = String(o.domain ?? '').trim()
      const confidence = Math.min(5, Math.max(1, parseInt(String(o.confidence ?? 3), 10) || 3))
      const domains = Array.isArray(o.domains)
        ? o.domains.map(String).filter(Boolean)
        : domain.includes('+')
          ? domain.split('+').map((d) => d.trim()).filter(Boolean)
          : [domain].filter(Boolean)

      if (!title || !trigger || !rationale || !first_action) continue
      if (domains.length < 2) continue

      out.push({
        title,
        trigger,
        rationale,
        expected_impact,
        first_action,
        domain: domains.join('+'),
        domains,
        confidence,
      })
    }
    return out.slice(0, 3)
  } catch {
    return []
  }
}

async function proposeMoves(context: Awaited<ReturnType<typeof gatherStrategistContext>>): Promise<StrategistMove[]> {
  if (!isAnthropicConfigured()) return []

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' })
  const factsJson = JSON.stringify(context, null, 0).slice(0, 14000)

  const res = await client.messages.create({
    model: enforceClaudeOnlyModel(),
    max_tokens: 1800,
    thinking: { type: 'adaptive' },
    system: [{ type: 'text', text: STRATEGIST_SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages: [{
      role: 'user',
      content:
        'আজকের cross-domain strategist pass — JSON array of moves (max 3) বা []।\n' +
        '≥২ domain ছাড়া কিছু propose করবেন না। Obvious daily-report items skip।\n\n' +
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
      purpose: 'daily_strategist',
    },
    costUsd: calcAnthropicChatCostUsd({
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    }),
    dedupKey: `strategist:${context.date}`,
  })

  return parseMoves(text)
}

function buildOwnerCard(moves: StrategistMove[]): string {
  const lines = [
    '🎯 *দৈনিক strategist — cross-domain moves*',
    '',
    'নিচের moves owner approve করলে add_owner_todo বা staff-task proposal দিয়ে execute করা যাবে — auto নয়।',
    '(correlation, causation নয়)',
    '',
  ]
  moves.forEach((m, i) => {
    lines.push(`*${i + 1}. ${m.title}* (confidence ${m.confidence}/5)`)
    lines.push(`• Trigger: ${m.trigger}`)
    lines.push(`• Domains: ${(m.domains ?? [m.domain]).join(' + ')}`)
    lines.push(`• Rationale: ${m.rationale}`)
    lines.push(`• Expected: ${m.expected_impact}`)
    lines.push(`• First action: ${m.first_action}`)
    lines.push('')
  })
  lines.push('Agent chat-এ approve করলে add_owner_todo / prepare_staff_task_proposal ব্যবহার করুন।')
  return lines.join('\n')
}

export async function runDailyStrategist(): Promise<{
  moves: number
  skipped: boolean
}> {
  const context = await gatherStrategistContext()
  const moves = await proposeMoves(context)

  if (!moves.length) {
    console.log('[strategist] no high-leverage moves — []')
    return { moves: 0, skipped: true }
  }

  const summary = buildOwnerCard(moves)

  await db.agentPendingAction.create({
    data: {
      type: 'strategist_moves',
      payload: { moves, date: context.date },
      summary,
      status: 'pending',
      businessId: 'ALMA_LIFESTYLE',
    },
  })

  await notifyOwner({
    tier: 2,
    title: 'Strategist moves — review করুন',
    message: summary.replace(/\*/g, ''),
    category: 'report',
  })

  void sendOwnerText(summary).catch(() => {})

  console.log(`[strategist] proposed=${moves.length} moves`)
  return { moves: moves.length, skipped: false }
}
