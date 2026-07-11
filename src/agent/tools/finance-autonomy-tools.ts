/**
 * Phase 4 (finance autonomy) — owner-facing visibility.
 *
 * `cashflow_forecast` is a READ-ONLY look-ahead: it projects the next ~30 days of
 * cash from the recent inflow/outflow run-rate plus upcoming bills + subscription
 * renewals, then shows the owner the trajectory, the lowest point, and whether a
 * shortfall is coming — plus how the autonomy policy would handle the alert
 * (🤖 handle / 📝 propose / ❓ ask). It performs NO actions and moves NO money.
 */
import type { AgentTool } from './registry'
import { planCashFlowAutonomy } from '@/agent/lib/finance/cashflow-forecast'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}
/** Whole-taka with Bangla digits, e.g. 12500 → "১২,৫০০". */
function taka(n: number): string {
  return bn(Math.round(n).toLocaleString('en-US'))
}

const MODE_TAG: Record<string, string> = { auto: '🤖', propose: '📝', ask: '❓' }

const cashflow_forecast: AgentTool = {
  name: 'cashflow_forecast',
  description:
    'Owner-facing read-only CASH-FLOW forecast. Projects the next ~30 days of cash from the recent '
    + 'revenue/expense run-rate plus upcoming bills and subscription renewals, then shows the trajectory, '
    + 'the lowest point, and whether a shortfall is coming — with how the autonomy policy would handle the '
    + 'alert (🤖 handle / 📝 propose / ❓ ask). Because there is no single cash-on-hand account, this is a '
    + 'NET cash-flow (income − expense) projection. '
    + 'Use for "নগদ-প্রবাহ পূর্বাভাস", "সামনে টাকার টান পড়বে কিনা", "ক্যাশ ফ্লো দেখাও", "cash flow forecast". Takes no action.',
  input_schema: {
    type: 'object' as const,
    properties: {
      horizonDays: { type: 'number', description: 'Days to look ahead (default 30)' },
      safetyFloorTaka: { type: 'number', description: 'Shortfall is flagged below this floor (default 0)' },
    },
  },
  handler: async (input) => {
    try {
      const horizonDays = typeof input.horizonDays === 'number' && input.horizonDays > 0 ? Math.round(input.horizonDays) : undefined
      const safetyFloorTaka = typeof input.safetyFloorTaka === 'number' ? Math.round(input.safetyFloorTaka) : undefined
      const plan = await planCashFlowAutonomy({ horizonDays, safetyFloorTaka })
      const f = plan.forecast

      const lines: string[] = []
      lines.push('💸 *নগদ-প্রবাহ পূর্বাভাস*')
      lines.push('')
      lines.push(`• স্বয়ংক্রিয় নীতি: ${plan.policyEnabled ? '🟢 চালু' : '🔴 বন্ধ'}`)
      lines.push(`• গত ${bn(plan.windowDays)} দিন: আয় ৳${taka(plan.revenueWindowTaka)} · খরচ ৳${taka(plan.expenseWindowTaka)}`)
      lines.push(`• দৈনিক নিট (আয়−খরচ): ${f.dailyNetTaka >= 0 ? '+' : '−'}৳${taka(Math.abs(f.dailyNetTaka))}`)
      lines.push(`• আগামী ${bn(f.horizonDays)} দিনে দেয় বিল/সাবস্ক্রিপশন: ৳${taka(f.totalObligationsTaka)}`)
      lines.push('')

      if (f.shortfall) {
        lines.push(`⚠️ সম্ভাব্য ঘাটতি: ${bn(f.shortfallDay ?? 0)} দিনের মাথায় নগদ সবচেয়ে নিচে নামবে (প্রায় ৳${taka(f.lowestBalanceTaka)})।`)
        lines.push(`প্রায় ৳${taka(f.shortfallGapTaka)} কম পড়তে পারে, Boss — আগেভাগে ব্যবস্থা নেওয়া ভালো।`)
      } else {
        lines.push(`✅ আগামী ${bn(f.horizonDays)} দিন নগদ-প্রবাহ ঠিক আছে বলে মনে হচ্ছে (সবচেয়ে নিচে ≈ ৳${taka(f.lowestBalanceTaka)})।`)
      }

      const tag = MODE_TAG[plan.action.mode] ?? '❓'
      lines.push('')
      lines.push(`${tag} ${plan.action.summary}`)

      if (plan.skippedForeign.length) {
        const fx = plan.skippedForeign.map((s) => `${s.label} (${s.currency} ${bn(s.amount)})`).join(', ')
        lines.push('')
        lines.push(`টীকা: বিদেশি-মুদ্রার খরচ আলাদা (হিসাবে ধরিনি): ${fx}`)
      }

      lines.push('')
      lines.push('(নগদ ব্যালেন্স জানা নেই বলে এটা নিট আয়−খরচ পূর্বাভাস — গড় রান-রেট থেকে।)')

      return {
        success: true,
        data: {
          previewOnly: true,
          policyEnabled: plan.policyEnabled,
          horizonDays: f.horizonDays,
          dailyNetTaka: f.dailyNetTaka,
          totalObligationsTaka: f.totalObligationsTaka,
          lowestBalanceTaka: f.lowestBalanceTaka,
          lowestDay: f.lowestDay,
          shortfall: f.shortfall,
          shortfallDay: f.shortfallDay,
          shortfallGapTaka: f.shortfallGapTaka,
          autonomyMode: plan.action.mode,
          skippedForeign: plan.skippedForeign,
          message: lines.join('\n'),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const FINANCE_AUTONOMY_TOOLS: AgentTool[] = [cashflow_forecast]
