/**
 * Chat mode — HOW the agent is allowed to work in this conversation.
 *
 * Owner ask 2026-07-25: a mode picker in his chat, like Claude Code's. The point
 * is not decoration — he wants to be able to say "this is big, run it under
 * Plan-Drive and let me watch it here" without the agent deciding for him, and
 * equally to say "just do it now, no plans".
 *
 * ONE axis only: execution style. Approvals stay where they already are (the
 * autonomy ladder + per-family grants). There is deliberately NO
 * "bypass permissions" mode — this is a live business with money, publishing and
 * staff messaging behind those cards, and a blanket bypass would be the one
 * setting that turns a mistake into an irreversible one.
 *
 * Modes are enforced by WITHHOLDING TOOLS, not by asking the model nicely. A
 * prompt rule is a request; an empty tool list is a guarantee (the same lesson as
 * listen mode).
 */

export type ChatMode = 'auto' | 'direct' | 'plan' | 'plan_drive'

export const CHAT_MODES: readonly ChatMode[] = ['auto', 'direct', 'plan', 'plan_drive']

export const DEFAULT_CHAT_MODE: ChatMode = 'auto'

export function isChatMode(v: unknown): v is ChatMode {
  return typeof v === 'string' && (CHAT_MODES as readonly string[]).includes(v)
}

export function normalizeChatMode(v: unknown): ChatMode {
  return isChatMode(v) ? v : DEFAULT_CHAT_MODE
}

export interface ChatModeMeta {
  id: ChatMode
  /** Owner-facing name (Bangla) — what the chip shows. */
  label: string
  /** One line under the name in the picker. */
  hint: string
}

export const CHAT_MODE_META: Record<ChatMode, ChatModeMeta> = {
  auto: {
    id: 'auto',
    label: 'অটো',
    hint: 'আমি নিজে ঠিক করব — ছোট কাজ এখনই, বড় কাজ Plan-Drive-এ',
  },
  direct: {
    id: 'direct',
    label: 'সরাসরি',
    hint: 'কোনো প্ল্যান নয় — এখনই করব, না পারলে সোজা বলব',
  },
  plan: {
    id: 'plan',
    label: 'প্ল্যান',
    hint: 'শুধু দেখে প্ল্যান দেব, কিছু চালাব না — আপনি বললে তবে',
  },
  plan_drive: {
    id: 'plan_drive',
    label: 'প্ল্যান-ড্রাইভ',
    hint: 'কাজটা durable প্ল্যানে ধাপে ধাপে — এই চ্যাটেই লাইভ দেখবেন',
  },
}

/**
 * Tools that carry the planning machinery. Withheld or required depending on
 * mode, so the mode is real rather than advisory.
 */
export const PLAN_TOOLS = ['make_plan', 'execute_plan', 'start_fix_campaign'] as const

/**
 * Which tools this mode may call.
 *  - 'all'        — no mode restriction (auto / plan_drive).
 *  - 'no_plans'   — direct mode: the planning tools are gone, so "I'll do it in
 *                   the background" is not available as an escape hatch.
 *  - 'read_only'  — plan mode: only reads + ask/memory + make_plan. Nothing that
 *                   changes the world runs until Boss says go.
 */
export type ToolPolicy = 'all' | 'no_plans' | 'read_only'

export function toolPolicyFor(mode: ChatMode): ToolPolicy {
  switch (mode) {
    case 'direct': return 'no_plans'
    case 'plan': return 'read_only'
    default: return 'all'
  }
}

/** Tools plan mode keeps even though they are not pure reads. */
const PLAN_MODE_ALLOWED_WRITES = new Set<string>([
  'make_plan',        // producing the plan IS the job in this mode
  'ask_user',         // asking Boss something is how it stays honest
  'save_memory', 'update_memory', 'graph_remember',
  'save_task_checkpoint',
  'find_tool',
])

/**
 * Deterministic filter applied to the model-facing tool list.
 * `isRead` comes from the capability manifest (mode === 'read').
 */
export function filterToolsForMode<T extends { name: string }>(
  mode: ChatMode,
  tools: T[],
  isRead: (name: string) => boolean,
): T[] {
  const policy = toolPolicyFor(mode)
  if (policy === 'all') return tools
  if (policy === 'no_plans') return tools.filter((t) => !(PLAN_TOOLS as readonly string[]).includes(t.name))
  return tools.filter((t) => isRead(t.name) || PLAN_MODE_ALLOWED_WRITES.has(t.name))
}

/**
 * The per-mode directive. Short on purpose: it rides every turn, and the
 * enforcement is the tool list, not these words.
 */
export function chatModeDirective(mode: ChatMode): string | null {
  switch (mode) {
    case 'direct':
      return (
        '[MODE: সরাসরি] এই চ্যাটে প্ল্যান বানানো বন্ধ — make_plan/execute_plan নেই। ' +
        'যা করার এই টার্নেই করো। এক টার্নে শেষ না হলে "background-এ করব" বোলো না; ' +
        'সোজা বলো কতটুকু হয়েছে আর কী বাকি।'
      )
    case 'plan':
      return (
        '[MODE: প্ল্যান] এই টার্নে কিছুই বাস্তবে বদলাবে না — লেখা/পাঠানো/খরচ/পোস্টের টুল তোমার হাতে নেই। ' +
        'Boss যদি এমন কিছু করতে বলেন যা এই মোডে করা যায় না (todo যোগ, মেসেজ, খরচ, পোস্ট), তাহলে ' +
        'গোলমেলে উত্তর না দিয়ে **সোজা বলো**: "এই মোডে আমি এটা করতে পারব না" — তারপর ঠিক কী করবে তার ' +
        'প্ল্যান দাও আর মনে করিয়ে দাও মোড বদলালেই করে ফেলবে। ' +
        'আগে দরকারি জিনিস পড়ে দেখো, তারপর Boss-কে পরিষ্কার প্ল্যান দাও: কী কী ধাপ, কোনটা আগে, ' +
        'ঝুঁকি কোথায়, আর কী কী তথ্য/অনুমতি লাগবে। শেষে জিজ্ঞেস করো এভাবে এগোবে কিনা। ' +
        'Boss "শুরু করো" বললে তিনি মোড বদলাবেন — নিজে থেকে চালানোর চেষ্টা কোরো না।'
      )
    case 'plan_drive':
      return (
        '[MODE: প্ল্যান-ড্রাইভ] ছোট এক-লাইনের প্রশ্ন ছাড়া বাকি সব কাজ make_plan → execute_plan দিয়ে ' +
        'durable প্ল্যানে তোলো, যাতে Boss এই চ্যাটেই ধাপে ধাপে দেখতে পান এবং কাজটা শেষ না হওয়া পর্যন্ত ' +
        'নিজে থেকে চলতে থাকে। প্ল্যান enroll করার পরে এক লাইনে বলো কী কী ধাপ ধরেছ।'
      )
    case 'auto':
    default:
      return (
        '[MODE: অটো] তুমি নিজে ঠিক করবে: ছোট/এক-ধাপের কাজ এখনই করো; বড়, দীর্ঘ বা বারবার ফিরে দেখা লাগে ' +
        'এমন কাজ make_plan → execute_plan দিয়ে Plan-Drive-এ তোলো। **কোনটা বাছলে সেটা এক লাইনে বলো**, ' +
        'যাতে Boss জানেন কাজটা এখন হচ্ছে নাকি পেছনে চলবে।'
      )
  }
}
