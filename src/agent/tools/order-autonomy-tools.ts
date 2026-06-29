/**
 * Phase 3 (order lifecycle autonomy) — owner-facing visibility.
 *
 * `order_lifecycle_scan` is a READ-ONLY panel that answers "what would the agent do
 * about my orders right now?": it runs the lifecycle planner (detected order issues +
 * a fresh fake-order scan), classifies each through the unified autonomy policy, and
 * shows the owner what the agent would HANDLE itself (🤖), PROPOSE (📝), or just FLAG
 * for the owner's decision (❓). It performs NO order writes and NO customer charges —
 * the owner acts through staff tasks / order confirmation as usual.
 */
import type { AgentTool } from './registry'
import { planOrderLifecycleAutonomy } from '@/agent/lib/orders/lifecycle-autonomy'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

const MODE_TAG: Record<string, string> = {
  auto: '🤖',
  propose: '📝',
  ask: '❓',
}

const order_lifecycle_scan: AgentTool = {
  name: 'order_lifecycle_scan',
  description:
    'Owner-facing read-only review of ORDER LIFECYCLE autonomy. Scans for order problems '
    + '(stuck pending, pile-ups, payment-method gaps, high cancel/return) plus possible fake/fraud '
    + 'orders, then shows what the agent would handle itself (🤖), propose (📝), or flag for your '
    + 'decision (❓) under the current autonomy policy. '
    + 'Use for "অর্ডার অটোমেশন এর অবস্থা", "অর্ডার নিয়ে তুমি কী করবে", "ভুয়া অর্ডার আছে কিনা". Takes no action.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const { planned, policyEnabled, fakeSignals } = await planOrderLifecycleAutonomy()

      const autoN = planned.filter((p) => p.mode === 'auto').length
      const proposeN = planned.filter((p) => p.mode === 'propose').length
      const askN = planned.filter((p) => p.mode === 'ask').length

      const lines: string[] = []
      lines.push('📦 *অর্ডার লাইফসাইকেল — অটোমেশন পর্যালোচনা*')
      lines.push('')
      lines.push(`• স্বয়ংক্রিয় নীতি: ${policyEnabled ? '🟢 চালু' : '🔴 বন্ধ'}`)
      lines.push(`• সম্ভাব্য ভুয়া/সমস্যাযুক্ত অর্ডার: ${bn(fakeSignals.length)}টি`)
      lines.push('')

      if (planned.length === 0) {
        lines.push('এখন কোনো অর্ডার-সমস্যা চোখে পড়ছে না, Sir — সব ঠিক আছে।')
      } else {
        lines.push(`আমি যা দেখছি (${bn(planned.length)}টি):`)
        for (const p of planned) {
          const tag = MODE_TAG[p.mode] ?? '❓'
          const refs = p.orders?.length ? ` — অর্ডার: ${p.orders.slice(0, 5).join(', ')}` : ''
          lines.push(`${tag} ${p.summary}${refs}`)
        }
        lines.push('')
        lines.push(
          `সারসংক্ষেপ: 🤖 নিজে দেখব ${bn(autoN)} · 📝 প্রস্তাব ${bn(proposeN)} · ❓ আপনার সিদ্ধান্ত ${bn(askN)}`,
        )
        lines.push('(🤖 = আমি নিজে · 📝 = প্রস্তাব দিই · ❓ = আপনার অনুমতি লাগবে)')
      }

      if (!policyEnabled) {
        lines.push('')
        lines.push('মনে রাখবেন: স্বয়ংক্রিয় নীতি এখন বন্ধ, তাই আমি নিজে কিছু করছি না — শুধু দেখাচ্ছি।')
      }

      return {
        success: true,
        data: {
          previewOnly: true,
          policyEnabled,
          fakeOrderCount: fakeSignals.length,
          autoCount: autoN,
          proposeCount: proposeN,
          askCount: askN,
          planned: planned.map((p) => ({
            kind: p.kind,
            mode: p.mode,
            summary: p.summary,
            orders: p.orders ?? [],
          })),
          message: lines.join('\n'),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const ORDER_AUTONOMY_TOOLS: AgentTool[] = [order_lifecycle_scan]
