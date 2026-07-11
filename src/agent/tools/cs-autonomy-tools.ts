/**
 * Phase 2 (CS auto-reply autonomy) — owner-facing visibility.
 *
 * `cs_autonomy_status` is a READ-ONLY panel that answers "how is the customer-service
 * auto-reply behaving right now?": the live CS mode, the unified autonomy policy that
 * now governs it (master switch + the `cs_reply` category mode), the confidence
 * threshold a reply must clear to auto-send, and how many replies the agent sent on
 * its own today (from the autonomy ledger). It performs NO actions — the owner tunes
 * behaviour through the Phase-1 `set_autonomy_policy` tool and the `cs_mode` control.
 */
import type { AgentTool } from './registry'
import { getCsMode } from '@/agent/lib/cs/modes'
import { csConfidenceThreshold } from '@/agent/lib/cs/confidence'
import { getAutonomyPolicy } from '@/agent/lib/autonomy-policy'
import { listRecentActions } from '@/agent/lib/autonomy-ledger'

const BN = '০১২৩৪৫৬৭৮৯'
function bn(n: number | string): string {
  return String(n).replace(/\d/g, (d) => BN[Number(d)])
}

const CS_MODE_LABEL_BN: Record<string, string> = {
  off: '🔴 বন্ধ (কোনো অটো-রিপ্লাই নেই)',
  shadow: '👁️ শ্যাডো (খসড়া বানায়, পাঠায় না)',
  auto_night: '🌙 রাতে অটো (রাত ১০টা–সকাল ৯টা)',
  auto: '🟢 অটো (নিজে উত্তর দেয়)',
}

const MODE_LABEL_BN: Record<string, string> = {
  auto: 'নিজে করে',
  propose: 'প্রস্তাব দেয়',
  ask: 'অনুমতি নেয়',
}

/** Dhaka YYYY-MM-DD for "today" filtering. */
function ymdDhaka(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d)
}

const cs_autonomy_status: AgentTool = {
  name: 'cs_autonomy_status',
  description:
    'Owner-facing read-only status of CUSTOMER-SERVICE auto-reply. Shows live CS mode (off/shadow/auto_night/auto), '
    + 'the unified autonomy policy now governing it (master switch + cs_reply category mode), the confidence '
    + 'threshold a reply must clear to auto-send, and how many replies the agent sent on its own today. '
    + 'Use for "CS auto-reply এর অবস্থা", "অটো-রিপ্লাই চালু আছে কিনা", "আজ নিজে কয়টা উত্তর দিয়েছ". Takes no action.',
  input_schema: { type: 'object' as const, properties: {} },
  handler: async () => {
    try {
      const [csMode, policy, recent] = await Promise.all([
        getCsMode(),
        getAutonomyPolicy(),
        listRecentActions(100),
      ])
      const threshold = csConfidenceThreshold()
      const csReplyMode = policy.categoryModes.cs_reply

      const today = ymdDhaka(new Date())
      const todayCsReplies = recent.filter(
        (e) => e.category === 'cs_reply' && !e.undone && ymdDhaka(new Date(e.at)) === today,
      ).length

      // Effective auto-send: live CS auto mode AND (autonomy off OR cs_reply set to auto).
      const csAutoOn = csMode === 'auto' || csMode === 'auto_night'
      const autonomyGoverns = policy.enabled
      const autoSendNow = csAutoOn && (!autonomyGoverns || csReplyMode === 'auto')

      const lines: string[] = []
      lines.push('🤖 *কাস্টমার-সার্ভিস অটো-রিপ্লাই*')
      lines.push('')
      lines.push(`• CS মোড: ${CS_MODE_LABEL_BN[csMode] ?? csMode}`)
      lines.push(`• স্বয়ংক্রিয় নীতি: ${policy.enabled ? '🟢 চালু' : '🔴 বন্ধ'}`)
      lines.push(`• cs_reply সিদ্ধান্ত: ${MODE_LABEL_BN[csReplyMode] ?? csReplyMode}`)
      lines.push(`• কনফিডেন্স থ্রেশহোল্ড: ${bn(Math.round(threshold * 100))}%`)
      lines.push(`• আজ নিজে উত্তর দিয়েছি: ${bn(todayCsReplies)}টি`)
      lines.push('')
      if (autoSendNow) {
        lines.push('এখন: কনফিডেন্স যথেষ্ট হলে আমি নিজেই কাস্টমারকে উত্তর দিচ্ছি, Boss।')
      } else if (csAutoOn && autonomyGoverns && csReplyMode !== 'auto') {
        lines.push(`এখন: উত্তর তৈরি করি, কিন্তু ${MODE_LABEL_BN[csReplyMode] ?? csReplyMode} — পাঠানোর আগে আপনাকে দেখাই।`)
      } else if (csMode === 'shadow') {
        lines.push('এখন: শুধু খসড়া বানাই, নিজে থেকে পাঠাই না — আপনি অনুমোদন দিলে যায়।')
      } else {
        lines.push('এখন: অটো-রিপ্লাই বন্ধ — নতুন মেসেজ এলে আপনাকে জানাই।')
      }

      return {
        success: true,
        data: {
          previewOnly: true,
          csMode,
          autonomyEnabled: policy.enabled,
          csReplyMode,
          confidenceThreshold: threshold,
          autoSendNow,
          todayAutoReplies: todayCsReplies,
          message: lines.join('\n'),
        },
      }
    } catch (err) {
      return { success: false, error: String(err) }
    }
  },
}

export const CS_AUTONOMY_TOOLS: AgentTool[] = [cs_autonomy_status]
