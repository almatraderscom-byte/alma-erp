/**
 * Phase 5 (autonomous heartbeat) — owner-facing HEARTBEAT CONTROL.
 *
 * One tool, `heartbeat_control`, that lets the owner inspect and steer the
 * autonomous "idle heartbeat" from any chat (no redeploy — writes KV):
 *   • action 'status'  (default) — is it on? daily cap, office-hours-only, today's
 *     head wakes, and the most-recent ticks (the same feed the UI panel shows).
 *   • action 'enable' / 'disable' — master toggle for the self-waking head.
 *   • action 'set_cap' — change the daily head-wake ceiling (cost control).
 *   • action 'test_now' — force one tick immediately so the owner can watch it work
 *     (bypasses the enabled / office-hours / change gates; still respects autonomy
 *     policy, so it never moves money on its own).
 *
 * Bangla owner-facing, "Sir/Boss" tone. Read paths fail safe.
 */
import type { AgentTool } from './registry'
import {
  getHeartbeatSettings,
  setHeartbeatSettings,
} from '@/agent/lib/heartbeat/heartbeat-settings'
import { listHeartbeats, headWakesToday } from '@/agent/lib/heartbeat/heartbeat-log'
// NOTE: brain.ts is imported LAZILY inside the test_now handler (not at module top).
// brain.ts pulls in the head runner (runOwnerTurn → core → the whole tool registry),
// and this file is itself part of that registry — a static import here forms an import
// cycle whose temporal-dead-zone only surfaces in a full `next build` (it broke the
// /api/assistant/day-shift page-data collection). The lazy import breaks the cycle.

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

const KIND_TAG: Record<string, string> = { idle: '🫧', active: '🤖', blocked: '📝', error: '⚠️' }

function fmtTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso))
}

async function statusMessage(): Promise<string> {
  const [settings, recent, wakes] = await Promise.all([
    getHeartbeatSettings(),
    listHeartbeats(6),
    headWakesToday(),
  ])
  const lines: string[] = []
  lines.push('💓 *এজেন্ট হার্টবিট*')
  lines.push('')
  lines.push(`• অবস্থা: ${settings.enabled ? '🟢 চালু' : '🔴 বন্ধ'}`)
  lines.push(
    `• নিজে থেকে চালু (auto-arm): ${settings.autoArm ? 'হ্যাঁ — কাজ বাকি থাকলে নিজেই জেগে ওঠে' : 'না'}`,
  )
  lines.push(`• অফিস-টাইমে সীমাবদ্ধ: ${settings.officeHoursOnly ? 'হ্যাঁ' : 'না'}`)
  lines.push(`• দৈনিক head-জাগার সীমা: ${bn(settings.dailyHeadWakeCap)} (আজ জেগেছে ${bn(wakes)} বার)`)
  lines.push('')
  if (recent.length === 0) {
    lines.push('এখনো কোনো টিক রেকর্ড হয়নি।')
  } else {
    lines.push('*সাম্প্রতিক টিক:*')
    for (const e of recent) {
      const tag = KIND_TAG[e.kind] ?? '•'
      lines.push(`${tag} (${fmtTime(e.at)}) ${e.summary}`)
    }
  }
  return lines.join('\n')
}

const heartbeat_control: AgentTool = {
  name: 'heartbeat_control',
  description:
    "Owner-facing control for the agent's autonomous \"idle heartbeat\" — the head waking on its own to "
    + 'check the business and proactively act/alert. action: "status" (default; shows on/off, daily cap, '
    + "today's wakes, recent ticks), \"enable\", \"disable\", \"set_cap\" (dailyHeadWakeCap), or \"test_now\" "
    + '(force one tick right now so the owner can watch it work). '
    + 'Use for "হার্টবিট চালু/বন্ধ করো", "এজেন্ট নিজে থেকে কী করছে দেখাও", "হার্টবিট টেস্ট করো", "heartbeat status".',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string',
        enum: ['status', 'enable', 'disable', 'set_cap', 'test_now'],
        description: 'What to do (default: status)',
      },
      dailyHeadWakeCap: { type: 'number', description: 'For action=set_cap: new daily head-wake ceiling (0–48)' },
    },
  },
  handler: async (input) => {
    try {
      const action = typeof input.action === 'string' ? input.action : 'status'

      if (action === 'enable' || action === 'disable') {
        // Manual on = on + self-managing; manual off = a real stop (clear autoArm too).
        await setHeartbeatSettings({ enabled: action === 'enable', autoArm: action === 'enable' })
        const msg = await statusMessage()
        return {
          success: true,
          data: {
            enabled: action === 'enable',
            message: `${action === 'enable' ? '✅ হার্টবিট চালু করলাম, Sir।' : '⏸️ হার্টবিট বন্ধ করলাম, Sir।'}\n\n${msg}`,
          },
        }
      }

      if (action === 'set_cap') {
        if (typeof input.dailyHeadWakeCap !== 'number') {
          return { success: false, error: 'dailyHeadWakeCap (number) required for set_cap' }
        }
        const next = await setHeartbeatSettings({ dailyHeadWakeCap: input.dailyHeadWakeCap })
        const msg = await statusMessage()
        return {
          success: true,
          data: { dailyHeadWakeCap: next.dailyHeadWakeCap, message: `✅ দৈনিক সীমা ${bn(next.dailyHeadWakeCap)} করলাম।\n\n${msg}` },
        }
      }

      if (action === 'test_now') {
        const { runHeartbeatTick } = await import('@/agent/lib/heartbeat/brain')
        const result = await runHeartbeatTick({ force: true })
        const tag = KIND_TAG[result.kind ?? 'idle'] ?? '•'
        const head = result.headWoke ? `head জেগেছে (খরচ ≈ $${result.costUsd.toFixed(4)})` : 'head জাগানোর দরকার পড়েনি'
        const status = await statusMessage()
        return {
          success: true,
          data: {
            ...result,
            message: `🧪 *হার্টবিট টেস্ট সম্পন্ন* — ${head}\n${tag} ${result.summary || '(কিছু লেখা নেই)'}\n\n${status}`,
          },
        }
      }

      // status (default)
      return { success: true, data: { message: await statusMessage() } }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const HEARTBEAT_TOOLS: AgentTool[] = [heartbeat_control]
