/**
 * Feature E — Insight→action এক-ট্যাপ cards ("পরামর্শ → অ্যাকশন").
 *
 * The morning briefing already SURFACES problems (low stock, stuck/piled-up
 * orders) and even pairs each with a recommendation. But the recommendation was
 * just prose — the owner still had to translate "আজ ~20টি রিঅর্ডার করুন" into an
 * actual step himself. Nothing turned an insight into a single, ready-to-run
 * action.
 *
 * This module closes that last gap: it maps the briefing's structured signals
 * (reorderSuggestions + orderIssues) into owner-facing one-tap ACTION CARDS.
 * Each card carries the insight, ONE recommended action, and the exact tool +
 * params the agent would run if the owner taps "do it" — so a suggestion becomes
 * a single confirm away from done.
 *
 * Safety: pure + read-only. buildActionCards is deterministic over briefing data
 * (no I/O) so it unit-tests cleanly; getActionCards only READS the briefing. The
 * cards' `action` is a *proposal* — nothing executes here. The bound tools they
 * point at (add_owner_todo) are themselves low-risk/reversible; this module never
 * mutates a task, dispatches staff, or touches money.
 */
import type { OwnerBriefingData } from '@/agent/lib/owner-briefing-data'
import { buildOwnerBriefingData } from '@/agent/lib/owner-briefing-data'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

export interface ActionCardAction {
  /** Tool the agent runs when the owner taps the card. */
  tool: string
  /** Ready-to-run params for that tool. */
  params: Record<string, unknown>
  /** Owner-facing button label (Bangla). */
  label: string
}

export interface ActionCard {
  /** Stable signal key for dedup / idempotency (e.g. "stock:<id>"). */
  id: string
  area: 'stock' | 'orders'
  urgency: 'high' | 'normal'
  /** The problem, in owner-facing Bangla. */
  insight: string
  /** The single recommended action, in Bangla. */
  recommendedAction: string
  /** The one-tap action the agent would execute. */
  action: ActionCardAction
}

export interface ActionCardsResult {
  cards: ActionCard[]
  /** Ready-to-show owner-facing Bangla list of the cards. */
  summaryBangla: string
}

/** Per-type recommendation + todo framing for an order issue. */
function orderIssueCopy(type: string): { recommend: string; todoTitle: string; label: string } | null {
  switch (type) {
    case 'stuck_pending':
      return {
        recommend: 'pending অর্ডারগুলো আজ confirm/deliver করুন — স্টাফকে push করুন',
        todoTitle: 'আটকে থাকা pending অর্ডার আজ ছাড় করান',
        label: 'স্টাফকে push করার টুডু যোগ করুন',
      }
    case 'pile_up':
      return {
        recommend: 'pending queue clear করুন — অগ্রাধিকার অনুযায়ী confirm করুন',
        todoTitle: 'জমে থাকা pending queue clear করুন',
        label: 'queue clear করার টুডু যোগ করুন',
      }
    case 'high_cancel':
      return {
        recommend: 'cancel কারণ খুঁজুন (CS/quality/pricing) — তারপর সিদ্ধান্ত নিন',
        todoTitle: 'বেশি cancel-এর কারণ খুঁজে বের করুন',
        label: 'কারণ খোঁজার টুডু যোগ করুন',
      }
    case 'high_return':
      return {
        recommend: 'return কারণ analyze করুন — quality/sizing/description চেক করুন',
        todoTitle: 'বেশি return-এর কারণ খতিয়ে দেখুন',
        label: 'return পর্যালোচনার টুডু যোগ করুন',
      }
    case 'mismatch':
      return {
        recommend: 'sheet sync refresh করুন বা ERP-তে সরাসরি verify করুন',
        todoTitle: 'অর্ডার count mismatch verify করুন',
        label: 'verify করার টুডু যোগ করুন',
      }
    default:
      return null
  }
}

/**
 * Build owner-facing one-tap action cards from briefing signals. Pure +
 * deterministic — no I/O. High-urgency cards come first; within a tier, stock
 * (reorder) before orders. Capped so the owner sees the few that matter.
 */
export function buildActionCards(
  briefing: Pick<OwnerBriefingData, 'reorderSuggestions' | 'orderIssues'>,
  opts: { limit?: number } = {},
): ActionCard[] {
  const limit = opts.limit ?? 8
  const cards: ActionCard[] = []

  // ── Reorder insights → "add reorder todo" cards ──
  for (const r of briefing.reorderSuggestions ?? []) {
    const qty = r.suggestedQty
    cards.push({
      id: `stock:${r.id}`,
      area: 'stock',
      urgency: r.urgency,
      insight: `${r.name}: ${r.reason}`,
      recommendedAction: `~${bn(qty)}টি রিঅর্ডার করুন`,
      action: {
        tool: 'add_owner_todo',
        params: {
          title: `রিঅর্ডার: ${r.name} (~${qty}টি)`,
          detail: r.reason,
          priority: r.urgency === 'high' ? 'high' : 'normal',
        },
        label: 'রিঅর্ডার টুডুতে যোগ করুন',
      },
    })
  }

  // ── Order issues (stuck / pile-up / etc.) → "add follow-up todo" cards ──
  for (const issue of briefing.orderIssues ?? []) {
    const copy = orderIssueCopy(issue.type)
    if (!copy) continue
    cards.push({
      id: `orders:${issue.type}`,
      area: 'orders',
      urgency: issue.severity,
      insight: issue.detail,
      recommendedAction: copy.recommend,
      action: {
        tool: 'add_owner_todo',
        params: {
          title: copy.todoTitle,
          detail: issue.detail,
          priority: issue.severity === 'high' ? 'high' : 'normal',
        },
        label: copy.label,
      },
    })
  }

  // High urgency first; keep stock ahead of orders within the same tier (stable sort).
  const urgRank = (u: ActionCard['urgency']) => (u === 'high' ? 0 : 1)
  const areaRank = (a: ActionCard['area']) => (a === 'stock' ? 0 : 1)
  cards.sort((a, b) => urgRank(a.urgency) - urgRank(b.urgency) || areaRank(a.area) - areaRank(b.area))

  return cards.slice(0, limit)
}

/** Compose the owner-facing Bangla card list. */
export function renderActionCardsBangla(cards: ActionCard[]): string {
  if (!cards.length) {
    return '✅ এই মুহূর্তে এক-ট্যাপ অ্যাকশনের মতো জরুরি কিছু নেই — সব গোছানো আছে, মাশাআল্লাহ।'
  }
  const lines: string[] = []
  lines.push('🃏 *এক-ট্যাপ অ্যাকশন কার্ড* — পরামর্শ থেকে সরাসরি কাজ:')
  lines.push('')
  cards.forEach((c, i) => {
    const flag = c.urgency === 'high' ? '🔴' : '🟡'
    lines.push(`${bn(i + 1)}. ${flag} ${c.insight}`)
    lines.push(`   → ${c.recommendedAction}`)
    lines.push(`   [${c.action.label}]`)
  })
  lines.push('')
  lines.push('কোন কার্ডে কাজ করব বলুন — "১ নম্বরটা করো" বললেই অ্যাকশন নেব, Sir।')
  return lines.join('\n')
}

/**
 * Read-only: load the current briefing and return ready-to-show action cards.
 * Best-effort — never throws.
 */
export async function getActionCards(opts: { limit?: number } = {}): Promise<ActionCardsResult> {
  try {
    const briefing = await buildOwnerBriefingData()
    const cards = buildActionCards(briefing, { limit: opts.limit })
    return { cards, summaryBangla: renderActionCardsBangla(cards) }
  } catch (err) {
    console.warn('[action-cards] getActionCards failed:', err instanceof Error ? err.message : err)
    return { cards: [], summaryBangla: renderActionCardsBangla([]) }
  }
}
