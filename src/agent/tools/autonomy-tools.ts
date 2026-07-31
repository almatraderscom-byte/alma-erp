/**
 * Phase 1 (autonomy foundation) — the owner-facing AUTONOMY CONTROL tools.
 *
 * Three tools that put the owner in full control of the agent's autonomy:
 *   • check_autonomy   — read-only dashboard: master switch, money cap, confidence
 *                        floor, per-category modes, the recent action ledger, and
 *                        the approvals still waiting in the batch.
 *   • set_autonomy_policy — tune the policy (master on/off, money cap, confidence
 *                        floor, a single category's mode). Owner-only knobs; writes KV.
 *   • undo_action      — reverse a recorded autonomous action (by id or "last").
 *
 * All Bangla owner-facing, "Boss/Boss" tone. Read paths fail safe; the setter only
 * touches KV (no migration, owner-tunable without redeploy).
 */
import type { AgentTool } from './registry'
import { prisma } from '@/lib/prisma'
import {
  AUTONOMY_CATEGORIES,
  AUTONOMY_ENABLED_KEY,
  AUTONOMY_MONEY_CAP_KEY,
  AUTONOMY_CONFIDENCE_MIN_KEY,
  AUTONOMY_MODE_KEY_PREFIX,
  getAutonomyPolicy,
  type AutonomyCategory,
  type AutonomyMode,
} from '@/agent/lib/autonomy-policy'
import { listRecentActions, undoAction } from '@/agent/lib/autonomy-ledger'

const CATEGORY_LABEL_BN: Record<AutonomyCategory, string> = {
  cs_reply: 'কাস্টমার রিপ্লাই',
  order_confirm: 'অর্ডার কনফার্ম',
  order_followup: 'অর্ডার ফলো-আপ',
  reorder: 'রিঅর্ডার',
  finance: 'অর্থ/হিসাব',
  marketing: 'মার্কেটিং',
  staff_task: 'স্টাফ কাজ',
  other: 'অন্যান্য',
}

const MODE_LABEL_BN: Record<AutonomyMode, string> = {
  auto: 'নিজে করবে',
  propose: 'প্রস্তাব দিয়ে করবে',
  ask: 'অনুমতি নিয়ে করবে',
}

function isCategory(v: string): v is AutonomyCategory {
  return (AUTONOMY_CATEGORIES as string[]).includes(v)
}
function isMode(v: string): v is AutonomyMode {
  return v === 'auto' || v === 'propose' || v === 'ask'
}

async function upsertKv(key: string, value: string): Promise<void> {
  await prisma.agentKvSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  })
}

const check_autonomy: AgentTool = {
  name: 'check_autonomy',
  description:
    'Read-only: show the agent\'s AUTONOMY control panel RIGHT NOW. Reports whether autonomous mode is ON ' +
    'or OFF (master switch), the auto-spend money cap (taka), the confidence floor, and the per-category ' +
    'mode (নিজে করবে / প্রস্তাব দিয়ে করবে / অনুমতি নিয়ে করবে). Also lists the most-recent actions the agent ' +
    'took on its own (the undo-able audit ledger) and how many approvals are still waiting in the batch. ' +
    'Use when the owner asks "এজেন্ট কি নিজে কাজ করছে / autonomy on আছে কিনা / নিজে কী কী করেছে / কী কী approval বাকি / ' +
    'autonomy setting দেখাও". Surfaces the picture only — never changes anything. Owner-facing, answer in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  handler: async () => {
    try {
      const policy = await getAutonomyPolicy()
      const recent = await listRecentActions(10)

      // Pending approval batch (best-effort — never block the panel on it).
      let pendingCount = 0
      let pendingPreview: { id: string; label: string }[] = []
      try {
        const { collectPendingItems } = await import('@/agent/lib/pending-followup')
        const items = await collectPendingItems()
        pendingCount = items.length
        pendingPreview = items.slice(0, 5).map((i) => ({ id: i.id, label: i.label }))
      } catch {
        /* keep zero */
      }

      const categoryLines = AUTONOMY_CATEGORIES.map(
        (c) => `• ${CATEGORY_LABEL_BN[c]}: ${MODE_LABEL_BN[policy.categoryModes[c]]}`,
      )

      const lines: string[] = []
      lines.push(
        policy.enabled
          ? '🟢 *স্বয়ংক্রিয় মোড চালু* — নিরাপদ কাজ নিজে করব, ঝুঁকিরগুলো জিজ্ঞেস করব।'
          : '🔴 *স্বয়ংক্রিয় মোড বন্ধ* — এখন সব সিদ্ধান্ত আপনাকে জিজ্ঞেস করেই নিচ্ছি।',
      )
      lines.push('')
      lines.push(`💸 অটো-খরচ সীমা: ৳${policy.moneyCapTaka} | আত্মবিশ্বাস ফ্লোর: ${Math.round(policy.confidenceMin * 100)}%`)
      lines.push('')
      lines.push('*ক্যাটাগরি অনুযায়ী নিয়ম:*')
      lines.push(...categoryLines)
      lines.push('')
      if (recent.length > 0) {
        lines.push(`*সাম্প্রতিক নিজে-করা কাজ (${recent.length}টি):*`)
        recent.slice(0, 5).forEach((e) => {
          lines.push(`• ${e.summary}${e.undone ? ' — (ফেরানো হয়েছে)' : ''}`)
        })
      } else {
        lines.push('এখনো নিজে থেকে কোনো কাজ করিনি।')
      }
      lines.push('')
      lines.push(
        pendingCount > 0
          ? `⏳ অপেক্ষমাণ approval: ${pendingCount}টি।`
          : '⏳ অপেক্ষমাণ কোনো approval নেই।',
      )

      return {
        success: true,
        data: {
          previewOnly: true,
          enabled: policy.enabled,
          moneyCapTaka: policy.moneyCapTaka,
          confidenceMin: policy.confidenceMin,
          categoryModes: policy.categoryModes,
          recentActions: recent,
          pendingCount,
          pendingPreview,
          message: lines.join('\n'),
        },
      }
    } catch (err) {
      return { success: false, error: `Autonomy check failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const set_autonomy_policy: AgentTool = {
  name: 'set_autonomy_policy',
  description:
    'Owner-only: TUNE the agent\'s autonomy policy. Use ONLY when the owner explicitly asks to change a setting — ' +
    'e.g. "autonomy চালু করো / বন্ধ করো", "অটো-খরচ সীমা ৫০০ করো", "confidence ৯০% করো", ' +
    '"কাস্টমার রিপ্লাই নিজে করতে দাও / প্রস্তাব মোডে রাখো / অনুমতি নিয়ে করো". Pass only the field(s) the owner names; ' +
    'leave the rest unset. `enabled` is the MASTER switch (OFF = nothing auto-fires). `moneyCapTaka` is the ' +
    'whole-taka auto-spend ceiling. `confidenceMin` is 0..1. `category`+`mode` set ONE category\'s rule ' +
    '(mode = auto | propose | ask). Money and irreversible actions ALWAYS stay owner-approved no matter the setting. ' +
    'Confirm the change back to the owner in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      enabled: { type: 'boolean', description: 'Master autonomy switch on/off' },
      moneyCapTaka: { type: 'number', description: 'Whole-taka auto-spend ceiling (>=0)' },
      confidenceMin: { type: 'number', description: 'Confidence floor 0..1 below which actions step down' },
      category: {
        type: 'string',
        enum: AUTONOMY_CATEGORIES as unknown as string[],
        description: 'Which category to set the mode for (requires `mode`)',
      },
      mode: {
        type: 'string',
        enum: ['auto', 'propose', 'ask'],
        description: 'Mode for the given category: auto | propose | ask',
      },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const changes: string[] = []

      if (typeof input.enabled === 'boolean') {
        await upsertKv(AUTONOMY_ENABLED_KEY, input.enabled ? 'true' : 'false')
        changes.push(input.enabled ? 'স্বয়ংক্রিয় মোড চালু করলাম' : 'স্বয়ংক্রিয় মোড বন্ধ করলাম')
      }

      if (input.moneyCapTaka !== undefined) {
        const cap = Number(input.moneyCapTaka)
        if (!Number.isFinite(cap) || cap < 0) {
          return { success: false, error: 'moneyCapTaka must be a number >= 0' }
        }
        const whole = Math.round(cap)
        await upsertKv(AUTONOMY_MONEY_CAP_KEY, String(whole))
        changes.push(`অটো-খরচ সীমা ৳${whole} করলাম`)
      }

      if (input.confidenceMin !== undefined) {
        const conf = Number(input.confidenceMin)
        if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
          return { success: false, error: 'confidenceMin must be a number between 0 and 1' }
        }
        await upsertKv(AUTONOMY_CONFIDENCE_MIN_KEY, String(conf))
        changes.push(`আত্মবিশ্বাস ফ্লোর ${Math.round(conf * 100)}% করলাম`)
      }

      if (input.category !== undefined || input.mode !== undefined) {
        const category = String(input.category ?? '')
        const mode = String(input.mode ?? '')
        if (!isCategory(category)) {
          return { success: false, error: `invalid category: ${category}. Valid: ${AUTONOMY_CATEGORIES.join(', ')}` }
        }
        if (!isMode(mode)) {
          return { success: false, error: `invalid mode: ${mode}. Valid: auto, propose, ask` }
        }
        await upsertKv(`${AUTONOMY_MODE_KEY_PREFIX}${category}`, mode)
        changes.push(`${CATEGORY_LABEL_BN[category]} → ${MODE_LABEL_BN[mode]}`)
      }

      if (changes.length === 0) {
        return {
          success: false,
          error: 'No policy field provided. Set enabled, moneyCapTaka, confidenceMin, or category+mode.',
        }
      }

      const policy = await getAutonomyPolicy()
      const message = `✅ ঠিক আছে, Boss — ${changes.join('; ')}।`

      return {
        success: true,
        data: {
          changed: changes,
          policy,
          message,
        },
      }
    } catch (err) {
      return { success: false, error: `Set autonomy policy failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}

const undo_action: AgentTool = {
  name: 'undo_action',
  description:
    'Reverse an action the agent took ON ITS OWN. Use when the owner says "এটা ফিরিয়ে দাও / আগেরটা undo করো / ' +
    'ওটা বাতিল করো / শেষ কাজটা ফেরাও". Pass `id` = "last" for the most-recent undo-able action, or a specific ' +
    'ledger entry id (from check_autonomy). It re-runs the inverse step (e.g. delete the todo it created) and ' +
    'marks the entry as undone. Only actions recorded with an undo handler can be reversed — money/irreversible ' +
    'actions were never auto-fired, so there is nothing to undo there. Confirm the result in Bangla.',
  input_schema: {
    type: 'object' as const,
    properties: {
      id: {
        type: 'string',
        description: 'Ledger entry id, or "last" for the most-recent undo-able action. Defaults to "last".',
      },
    },
    required: [],
  },
  handler: async (input) => {
    try {
      const id = String(input.id ?? 'last').trim() || 'last'
      const res = await undoAction(id)

      if (!res.ok) {
        const reason =
          res.detail === 'not_found'
            ? 'এই কাজটা খুঁজে পেলাম না, Boss।'
            : res.detail === 'already_undone'
              ? 'এটা তো আগেই ফেরানো হয়ে গেছে, Boss।'
              : res.detail === 'no_undo_available'
                ? 'এই কাজটা ফেরানো যায় না, Boss — এর কোনো undo নেই।'
                : `ফেরাতে পারলাম না: ${res.detail}`
        return { success: false, error: res.detail, data: { ok: false, message: reason, entry: res.entry } }
      }

      const label = res.entry?.undo?.label || res.entry?.summary || 'কাজটা'
      return {
        success: true,
        data: {
          ok: true,
          entry: res.entry,
          message: `✅ ফিরিয়ে দিলাম, Boss — "${label}"।`,
        },
      }
    } catch (err) {
      return { success: false, error: `Undo failed: ${err instanceof Error ? err.message : String(err)}` }
    }
  },
}


// ── B6 — a standing "just do it", time-boxed and asked for, never taken ──────

/** Longest a single grant may run. A permission with no end is not a grant. */
const MAX_GRANT_MINUTES = 240

/**
 * Families a grant may NEVER cover, whatever Boss types in a hurry.
 * R4 is owner-only in every mode, forever (permission-mode rule 2).
 */
const UNGRANTABLE_FAMILIES = new Set(['money-movement', 'security-permissions'])

const request_standing_permission: AgentTool = {
  name: 'request_standing_permission',
  description:
    'Ask Boss for a TIME-BOXED standing permission so a family of work stops asking each time — '
    + '"পরের ২ ঘণ্টা অর্ডারগুলো নিজেই আপডেট করো", "আজ বিকেল পর্যন্ত স্টাফ মেসেজ নিজে পাঠাও". '
    + 'Stages an approval card naming the families, the minutes and the reason; the grant only exists '
    + 'after Boss approves, and it expires on its own. NEVER call this to widen your own hands mid-task — '
    + 'only when Boss says the asking itself is the problem. Money movement and permissions can never be granted.',
  input_schema: {
    type: 'object' as const,
    properties: {
      families: {
        type: 'array',
        description: 'Task families to cover, from the autonomy catalog (e.g. staff-messaging, customer-messaging, public-publish).',
        items: { type: 'string' },
      },
      minutes: { type: 'number', description: `How long, in minutes (max ${MAX_GRANT_MINUTES}).` },
      reason: { type: 'string', description: 'Why this helps, in one line — shown on the card.' },
      conversationId: { type: 'string', description: 'Server-managed conversation id — omit; the server fills it automatically.' },
    },
    required: ['families', 'minutes'],
  },
  handler: async (input) => {
    try {
      const conversationId = input.conversationId ? String(input.conversationId) : null
      if (!conversationId) {
        return { success: false, error: 'grant একটা নির্দিষ্ট কথোপকথনে বসে — conversation ছাড়া দেওয়া যায় না।' }
      }

      const { TASK_FAMILIES } = await import('@/agent/lib/autonomy-task-catalog')
      const known = new Map(TASK_FAMILIES.map((f) => [f.id, f]))

      const raw = Array.isArray(input.families) ? input.families.map((f) => String(f).trim()) : []
      if (!raw.length) return { success: false, error: 'কোন কাজের পরিবারের জন্য, সেটা বলুন (families খালি)।' }

      const families: string[] = []
      for (const id of raw) {
        const fam = known.get(id)
        if (!fam) {
          return {
            success: false,
            error: `"${id}" চেনা task family নয় — check_autonomy দিয়ে নামগুলো দেখে নিন।`,
          }
        }
        if (UNGRANTABLE_FAMILIES.has(id) || fam.tier === 'R4') {
          return {
            success: false,
            error: `${fam.label} কখনোই আগাম অনুমতিতে চলে না — টাকা সরানো আর পারমিশন প্রতিবার Boss-এর হাতেই থাকে।`,
          }
        }
        if (!families.includes(id)) families.push(id)
      }

      const minutes = Math.round(Number(input.minutes))
      if (!Number.isFinite(minutes) || minutes <= 0) {
        return { success: false, error: 'কত মিনিটের জন্য, সেটা ০-এর বেশি সংখ্যায় দিন।' }
      }
      if (minutes > MAX_GRANT_MINUTES) {
        return {
          success: false,
          error: `একবারে সর্বোচ্চ ${MAX_GRANT_MINUTES} মিনিট — এর বেশি লাগলে মেয়াদ শেষে আবার চাইব।`,
        }
      }

      const reason = input.reason ? String(input.reason).trim().slice(0, 200) : null
      const labels = families.map((id) => known.get(id)!.label)
      const expiresAt = new Date(Date.now() + minutes * 60_000)

      const summary =
        `🔓 সময়-বাঁধা অনুমতি চাইছি\n`
        + `কাজ: ${labels.join(', ')}\n`
        + `মেয়াদ: ${minutes} মিনিট (আনুমানিক ${expiresAt.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit' })} পর্যন্ত)\n`
        + (reason ? `কারণ: ${reason}\n` : '')
        + `\n✅ approve করলে এই কাজগুলো ওই সময়টুকু আর কার্ড ছাড়াই হবে — মেয়াদ শেষে নিজে থেকেই বন্ধ।\n`
        + `⛔ টাকা সরানো ও পারমিশন এর বাইরে — ওগুলো সবসময় আপনার হাতে।\n`
        + `যেকোনো সময় মোড বদলালেই অনুমতি বাতিল।`

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = await (prisma as any).agentPendingAction.create({
        data: {
          conversationId,
          type: 'permission_grant',
          payload: { families, minutes, reason, conversationId },
          summary,
          costEstimate: 0,
          status: 'pending',
        },
      })

      return {
        success: true,
        data: {
          pendingActionId: action.id as string,
          families,
          minutes,
          message: 'সময়-বাঁধা অনুমতির approval card পাঠানো হয়েছে — approve করলেই চালু, তার আগে নয়।',
        },
      }
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) }
    }
  },
}

export const AUTONOMY_TOOLS: AgentTool[] = [check_autonomy, set_autonomy_policy, undo_action, request_standing_permission]
