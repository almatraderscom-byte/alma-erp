/**
 * Harness round 2 — OWNER-CONFIGURABLE hook rules (no redeploy).
 *
 * Claude Code lets the user add hooks/permission rules in settings.json;
 * here the owner does the same through `agent_kv_settings` key
 * `agent_hook_rules` — a JSON array of rules applied to EVERY tool call via
 * the generic turn-hooks layer (both head paths):
 *
 *   [
 *     { "tool": "send_whatsapp",  "action": "block",  "message": "..." },
 *     { "tool": "wa_*",           "action": "block" },
 *     { "tool": "post_to_facebook", "action": "notify" }
 *   ]
 *
 * SAFETY INVARIANT: a rule can only RESTRICT (block) or OBSERVE (notify).
 * There is deliberately no "allow" action — kv rules can never weaken the
 * owner-intent gate, the AIOS door, approval contracts or capability controls.
 * Everything fails open: a broken rules JSON simply registers nothing.
 */
import { prisma } from '@/lib/prisma'
import {
  registerPreToolHook,
  registerPostToolHook,
  clearTurnHooks,
  type PreToolHook,
  type PostToolHook,
} from '@/agent/lib/turn-hooks'

export const HOOK_RULES_KV_KEY = 'agent_hook_rules'

export interface OwnerHookRule {
  /** Exact tool name, or a prefix glob like "wa_*". */
  tool: string
  action: 'block' | 'notify'
  /** Owner-facing Bangla message for block rules. */
  message?: string
  enabled?: boolean
}

export function parseHookRules(raw: unknown): OwnerHookRule[] {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!Array.isArray(value)) return []
    const rules: OwnerHookRule[] = []
    for (const item of value) {
      if (!item || typeof item !== 'object') continue
      const tool = String((item as { tool?: unknown }).tool ?? '').trim()
      const action = String((item as { action?: unknown }).action ?? '').trim()
      if (!tool || (action !== 'block' && action !== 'notify')) continue
      if ((item as { enabled?: unknown }).enabled === false) continue
      rules.push({
        tool,
        action,
        message: typeof (item as { message?: unknown }).message === 'string'
          ? ((item as { message?: unknown }).message as string)
          : undefined,
        enabled: true,
      })
    }
    return rules.slice(0, 50)
  } catch {
    return []
  }
}

export function ruleMatchesTool(rule: OwnerHookRule, toolName: string): boolean {
  const pattern = rule.tool.toLowerCase()
  const name = toolName.toLowerCase()
  if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1))
  return name === pattern
}

function blockHook(rule: OwnerHookRule, idx: number): PreToolHook {
  return {
    name: `kv:${idx}:block:${rule.tool}`,
    run: (ctx) =>
      ruleMatchesTool(rule, ctx.toolName)
        ? {
            action: 'block',
            message:
              rule.message
              ?? `Boss-এর সেট করা নিয়মে ${ctx.toolName} টুলটা এখন বন্ধ। দরকার হলে Boss settings থেকে নিয়মটা তুলে দেবেন।`,
          }
        : { action: 'allow' },
  }
}

function notifyHook(rule: OwnerHookRule, idx: number): PostToolHook {
  return {
    name: `kv:${idx}:notify:${rule.tool}`,
    run: (ctx) => {
      if (!ruleMatchesTool(rule, ctx.toolName)) return
      // Fire-and-forget; notification failure must never affect the turn.
      void import('@/agent/lib/notify-owner')
        .then(({ notifyOwner }) =>
          notifyOwner({
            tier: 1,
            title: 'Agent tool watch',
            message: `${ctx.toolName} চলল (${ctx.success ? 'সফল' : 'ব্যর্থ'}) — আপনার watch নিয়ম অনুযায়ী জানালাম।`,
            category: 'task',
          }),
        )
        .catch(() => {})
    },
  }
}

/**
 * Load the owner's rules from kv and (re)register them for this process.
 * Called at the start of every owner turn in both head paths. Clearing +
 * re-registering keeps serverless instances in sync with fresh kv edits
 * (built-in code hooks, if any are ever added, must re-register the same way).
 */
export async function applyOwnerHookRules(): Promise<number> {
  let rules: OwnerHookRule[] = []
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({
      where: { key: HOOK_RULES_KV_KEY },
      select: { value: true },
    })
    rules = parseHookRules(row?.value)
  } catch {
    return 0 // fail-open: no kv/table → no rules
  }
  clearTurnHooks()
  rules.forEach((rule, idx) => {
    if (rule.action === 'block') registerPreToolHook(blockHook(rule, idx))
    else registerPostToolHook(notifyHook(rule, idx))
  })
  return rules.length
}
