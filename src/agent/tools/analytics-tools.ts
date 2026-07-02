import type { AgentTool } from './registry'
import { runGa4Report, isGa4Configured } from '@/agent/lib/ga4'

/**
 * GA4 marketing-analytics tools (Growth Feature 5). Read-only Google Analytics 4
 * data so the head can answer "which marketing actually drives sales" — sessions,
 * traffic source/medium, conversions and revenue. Reuses the shared Google OAuth
 * (Feature 1). Read-only → no approval card.
 */

/** GA4 dimension per requested breakdown. */
const BREAKDOWN_DIMENSION: Record<string, string> = {
  source_medium: 'sessionSourceMedium',
  channel: 'sessionDefaultChannelGroup',
  landing_page: 'landingPagePlusQueryString',
}

const METRICS = ['sessions', 'totalUsers', 'conversions', 'totalRevenue'] as const

const get_ga4_report: AgentTool = {
  name: 'get_ga4_report',
  description:
    'REAL Google Analytics 4 data for almatraders.com (FREE, read-only) — sessions, users, conversions and ' +
    'revenue over a date range, plus a breakdown so you can see WHICH channel/source drives traffic and sales ' +
    '(marketing ROI). This is ground truth from Google Analytics. Defaults to the last 28 days broken down by ' +
    'traffic source/medium. Requires the owner to have connected Google once (Growth page) WITH Analytics ' +
    'permission, and GA4_PROPERTY_ID set. Dates accept YYYY-MM-DD or GA4 shorthands like "28daysAgo"/"yesterday".',
  input_schema: {
    type: 'object' as const,
    properties: {
      startDate: { type: 'string', description: 'YYYY-MM-DD or "NdaysAgo". Default: "28daysAgo".' },
      endDate: { type: 'string', description: 'YYYY-MM-DD or "yesterday"/"today". Default: "yesterday".' },
      breakdown: {
        type: 'string',
        enum: ['source_medium', 'channel', 'landing_page', 'none'],
        description: 'How to break down the rows. "none" = totals only. Default: "source_medium".',
      },
      limit: { type: 'number', description: 'Max breakdown rows (default 15, max 100).' },
    },
  },
  handler: async (input) => {
    if (!(await isGa4Configured())) {
      // Distinguish the two "not ready" reasons for a clearer nudge.
      const r = await runGa4Report({ startDate: '7daysAgo', endDate: 'yesterday', dimensions: [], metrics: ['sessions'] })
      return r.ok ? { success: true, data: r } : { success: false, error: r.error }
    }

    const startDate = input.startDate ? String(input.startDate) : '28daysAgo'
    const endDate = input.endDate ? String(input.endDate) : 'yesterday'
    const breakdown = String(input.breakdown ?? 'source_medium')
    const limit = Math.min(Math.max(Number(input.limit ?? 15), 1), 100)
    const dimension = BREAKDOWN_DIMENSION[breakdown]

    // Totals (no dimensions) always; breakdown only when requested + valid.
    const [totals, broken] = await Promise.all([
      runGa4Report({ startDate, endDate, dimensions: [], metrics: [...METRICS] }),
      dimension
        ? runGa4Report({ startDate, endDate, dimensions: [dimension], metrics: [...METRICS], limit })
        : Promise.resolve(null),
    ])

    if (!totals.ok) return { success: false, error: totals.error }

    const totRow = totals.rows[0]
    const summary = totRow
      ? {
          sessions: totRow.metrics[0] ?? 0,
          users: totRow.metrics[1] ?? 0,
          conversions: totRow.metrics[2] ?? 0,
          revenue: Math.round((totRow.metrics[3] ?? 0) * 100) / 100,
        }
      : { sessions: 0, users: 0, conversions: 0, revenue: 0 }

    const rows =
      broken && broken.ok
        ? broken.rows.map((r) => ({
            label: r.dimensions[0] ?? '(unknown)',
            sessions: r.metrics[0] ?? 0,
            users: r.metrics[1] ?? 0,
            conversions: r.metrics[2] ?? 0,
            revenue: Math.round((r.metrics[3] ?? 0) * 100) / 100,
          }))
        : []

    return {
      success: true,
      data: {
        dateRange: { startDate, endDate },
        breakdown: dimension ? breakdown : 'none',
        totals: summary,
        rows,
      },
    }
  },
}

export const ANALYTICS_TOOLS: AgentTool[] = [get_ga4_report]

export const ANALYTICS_ROLE_PROMPT = `
## Analytics (GA4)
সাইটে আসল ট্রাফিক, কনভার্সন ও রেভিনিউ জানতে **get_ga4_report** ব্যবহার করুন — Google Analytics 4 থেকে sessions/users/conversions/revenue (ডিফল্ট শেষ ২৮ দিন), সাথে source/medium বা channel-ভিত্তিক breakdown যাতে বোঝা যায় **কোন মার্কেটিং আসলে সেল আনছে** (marketing ROI)। ফ্রি ও read-only — Approve লাগে না। (owner একবার Growth পেজ থেকে Google connect করলে + GA4_PROPERTY_ID সেট থাকলে চালু হবে।)
`
