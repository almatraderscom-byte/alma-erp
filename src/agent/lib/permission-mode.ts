/**
 * PM-0 — permission modes: the pure core.
 *
 * The second axis of the mode picker. `chat-mode.ts` decides HOW the agent works
 * (plan / direct / plan-drive); this decides HOW MUCH it may do without Boss.
 * Owner ask 2026-07-27, after he compared his chat to Claude Code's permission
 * modes: *"amr chat er moddhe mode select korle agent sei vabe kaj excute korbe"*.
 *
 * Design rules that the rest of the system leans on:
 *
 *  1. **A mode can only ever tighten.** The risk-tier ceiling in
 *     `autonomy-rollout.maxStageForTier` is the floor of safety: R3 caps at a
 *     card, R4 at owner-only. No mode, rule, or grant here can lift them. That
 *     is why a "fast" mode is safe to offer at all — it is arithmetic, not a
 *     promise in a prompt.
 *  2. **R4 is owner-only in every mode.** Money movement and permissions are his,
 *     always, with no env override and no elevation path.
 *  3. **Pure.** No I/O, no clock of its own (callers pass `now`), no imports that
 *     touch the database — so the guard, the prompt builder, the UI and the tests
 *     all reason from exactly the same table.
 *
 * This file deliberately contains NO enforcement. PM-1 records and displays the
 * mode; PM-2 is the first phase that lets it change what happens.
 */
import type { RiskTier } from '@/agent/lib/autonomy-task-catalog'

export type PermissionMode = 'plan' | 'careful' | 'standard' | 'supervised' | 'elevated'

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'plan',
  'careful',
  'standard',
  'supervised',
  'elevated',
]

/** A new chat starts here. The loosest mode is never sticky — it is re-chosen. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = 'standard'

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v)
}

export function normalizePermissionMode(v: unknown): PermissionMode {
  return isPermissionMode(v) ? v : DEFAULT_PERMISSION_MODE
}

/**
 * Restrictive → permissive. Used for inheritance: a sub-agent, a worker or a
 * scheduled run may never exceed the mode it was spawned under (gap G6).
 */
const MODE_RANK: Record<PermissionMode, number> = {
  plan: 0,
  careful: 1,
  standard: 2,
  supervised: 3,
  elevated: 4,
}

/** The MORE restrictive of two modes. */
export function narrowerMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return MODE_RANK[a] <= MODE_RANK[b] ? a : b
}

export interface PermissionModeMeta {
  id: PermissionMode
  /** Owner-facing name (Bangla) — the chip. */
  label: string
  /** One line under the name in the picker. */
  hint: string
  /** Oversight posture, in the industry's terms. */
  posture: 'in_the_loop' | 'on_the_loop' | 'time_boxed'
}

export const PERMISSION_MODE_META: Record<PermissionMode, PermissionModeMeta> = {
  plan: {
    id: 'plan',
    label: 'প্ল্যান',
    hint: 'শুধু দেখব আর প্ল্যান দেব — কিছুই বদলাবে না, কার্ডও যাবে না',
    posture: 'in_the_loop',
  },
  careful: {
    id: 'careful',
    label: 'সতর্ক',
    hint: 'যা কিছু বদলায় সবই আপনার অনুমোদনে — ছোট কাজও',
    posture: 'in_the_loop',
  },
  standard: {
    id: 'standard',
    label: 'স্বাভাবিক',
    hint: 'রোজকার কাজ নিজে করব, ঝুঁকির কাজ আপনার অনুমোদনে',
    posture: 'in_the_loop',
  },
  supervised: {
    id: 'supervised',
    label: 'তত্ত্বাবধান',
    hint: 'কাজ করে পরে জানাব, এক ট্যাপে ফেরানো যাবে — ঝুঁকির কাজ এক কার্ডে',
    posture: 'on_the_loop',
  },
  elevated: {
    id: 'elevated',
    label: 'জরুরি অনুমতি',
    hint: 'আপনার বেঁধে দেওয়া কাজে, বেঁধে দেওয়া সময়ের জন্য — নিজে থেকেই মেয়াদ শেষ',
    posture: 'time_boxed',
  },
}

/**
 * What a mode does with ONE action.
 *  - `auto`       — runs, no card
 *  - `card`       — staged for Boss's approval
 *  - `blocked`    — this mode does not do this kind of thing at all (Plan)
 *  - `owner_only` — R4: Boss performs it himself; the agent may only observe
 */
export type ModeVerdict = 'auto' | 'card' | 'blocked' | 'owner_only'

/**
 * A time-boxed elevation (the JIT pattern): named task families only, always
 * with an expiry. Never applies to R4.
 */
export interface ElevationGrant {
  /** Task-family ids from autonomy-task-catalog, e.g. 'public-publish'. */
  families: readonly string[]
  /** ISO timestamp — the LATEST cutoff across families (back-compat + display). */
  expiresAt: string
  /**
   * Per-family cutoff. Two grants approved at different times must keep their
   * own windows: a 15-minute staff grant must not inherit a 4-hour customer one
   * because they overlapped (review bot, #667). Absent → `expiresAt` applies to
   * every family, which is what older rows look like.
   */
  windows?: Readonly<Record<string, string>>
}

/** When does THIS family's permission end? Falls back to the grant-wide cutoff. */
export function familyExpiry(grant: ElevationGrant, family: string): string {
  return grant.windows?.[family] ?? grant.expiresAt
}

/** Is the grant live FOR THIS FAMILY specifically? */
export function isFamilyGrantLive(
  grant: ElevationGrant | null | undefined,
  family: string,
  now: number,
): boolean {
  if (!grant || !grant.families.includes(family)) return false
  const t = Date.parse(familyExpiry(grant, family))
  return Number.isFinite(t) && t > now
}

/**
 * Read a grant off the conversation row. Anything malformed is NO grant — a
 * permission this system cannot fully verify is one it does not hand out.
 */
export function parseElevationGrant(raw: unknown): ElevationGrant | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { families?: unknown; expiresAt?: unknown }
  const expiresAt = typeof obj.expiresAt === 'string' ? obj.expiresAt.trim() : ''
  if (!expiresAt || !Number.isFinite(Date.parse(expiresAt))) return null
  const families = Array.isArray(obj.families)
    ? obj.families.filter((f): f is string => typeof f === 'string' && f.trim().length > 0)
    : []
  if (families.length === 0) return null
  const rawWindows = (obj as { windows?: unknown }).windows
  const windows: Record<string, string> = {}
  if (rawWindows && typeof rawWindows === 'object') {
    for (const [family, at] of Object.entries(rawWindows as Record<string, unknown>)) {
      if (typeof at === 'string' && Number.isFinite(Date.parse(at))) windows[family] = at
    }
  }
  return Object.keys(windows).length ? { families, expiresAt, windows } : { families, expiresAt }
}

export function isElevationGrantLive(grant: ElevationGrant | null | undefined, now: number): boolean {
  if (!grant || !grant.expiresAt || grant.families.length === 0) return false
  const t = Date.parse(grant.expiresAt)
  return Number.isFinite(t) && t > now
}

export interface ModeVerdictInput {
  mode: PermissionMode
  tier: RiskTier
  /** Task family id — only consulted for an elevation grant. */
  taskClass?: string
  grant?: ElevationGrant | null
  now?: number
}

/**
 * The whole permission table, in one function.
 *
 * Read the R4 line and the R3 line across every mode before changing anything
 * here: R4 is never anything but owner-only, and R3 is never `auto` except under
 * a live, family-scoped, expiring grant.
 */
export function modeVerdict(input: ModeVerdictInput): ModeVerdict {
  const { mode, tier } = input
  // Rule 2 — no mode, grant or rule may touch this.
  if (tier === 'R4') return 'owner_only'

  // A LIVE, FAMILY-SCOPED grant lifts the card for the families it names —
  // whatever mode sits underneath — and touches nothing else.
  //
  // It used to be reachable only by switching the whole conversation to
  // `elevated`, which is a different and much larger promise: from Careful,
  // that one switch also stopped asking about every unrelated R1/R2 write (the
  // review bot's P1 on #667). A grant for staff-messaging must mean
  // staff-messaging, so it is read here instead of replacing the mode.
  //
  // Plan is the exception: in Plan nothing changes at all, by design. A grant
  // does not un-plan a plan.
  if (mode !== 'plan' && input.taskClass
    && isFamilyGrantLive(input.grant, input.taskClass, input.now ?? 0)) {
    return 'auto'
  }

  switch (mode) {
    case 'plan':
      // Reading is how a plan gets written. Everything else is not merely
      // gated — it is absent, so "it planned but also did something" cannot
      // happen even if the model tries.
      return tier === 'R0' ? 'auto' : 'blocked'

    case 'careful':
      return tier === 'R0' ? 'auto' : 'card'

    case 'standard':
    case 'supervised':
      // Supervised differs from standard in BEHAVIOUR (told-after, undo armed,
      // approvals batched per job), not in what is permitted. Keeping the
      // verdicts identical is deliberate: the difference must never be a
      // difference in authority.
      return tier === 'R3' ? 'card' : 'auto'

    case 'elevated': {
      // The named families were already handled above. Everything else in this
      // mode behaves like standard — an R3 action still gets a card.
      return tier === 'R3' ? 'card' : 'auto'
    }
  }
}

/**
 * The least-permissive mode in which this tier is not simply refused — i.e. what
 * Boss would have to switch to. `null` for R4, which no mode unlocks.
 *
 * This is what makes the mode advisor concrete instead of vague: the agent does
 * not guess a mode, it computes the minimum one.
 */
export function minimumModeFor(tier: RiskTier): PermissionMode | null {
  if (tier === 'R4') return null
  if (tier === 'R0') return 'plan'
  return 'careful'
}

/**
 * The mode that would let this run WITHOUT a card — used when Boss asks "how do
 * I stop it asking me every time". `null` when nothing but a card will do.
 */
export function autoModeFor(tier: RiskTier): PermissionMode | null {
  if (tier === 'R4' || tier === 'R3') return null
  if (tier === 'R0') return 'plan'
  return 'standard'
}

// ── The mode advisor (owner requirement 2026-07-27) ──────────────────────────
//
// "ami bhule onno mode e thakle agent jeno amk mode change korte bole kajer
// dhoron bujhe." A mode that silently swallows a request is a trap: he takes the
// plan, asks for the work, and gets a confused half-answer instead of a straight
// "this needs a different mode". So the refusal has to carry its own remedy.

export interface ModeAdvice {
  verdict: ModeVerdict
  /** True when the MODE is the reason — not risk, not policy, not a missing tool. */
  blockedByMode: boolean
  /** The mode Boss would switch to. null when no mode unlocks it (R4). */
  suggestedMode: PermissionMode | null
  /** What the agent should say, in Bangla. Already complete — do not paraphrase. */
  reasonBn: string
}

export function adviseForAction(input: ModeVerdictInput & { whatBn?: string }): ModeAdvice {
  const verdict = modeVerdict(input)
  const what = input.whatBn?.trim() || 'এই কাজটা'
  const current = PERMISSION_MODE_META[input.mode].label

  if (verdict === 'owner_only') {
    return {
      verdict,
      blockedByMode: false,
      suggestedMode: null,
      reasonBn:
        `${what} মাস্টার-লেভেলের সিদ্ধান্ত (টাকা সরানো / নিরাপত্তা) — কোনো মোডেই আমি নিজে করতে পারি না, `
        + 'আপনাকেই করতে হবে। মোড বদলালেও এটা বদলাবে না।',
    }
  }

  if (verdict === 'blocked') {
    const suggested = minimumModeFor(input.tier)
    const suggestedLabel = suggested ? PERMISSION_MODE_META[suggested].label : null
    return {
      verdict,
      blockedByMode: true,
      suggestedMode: suggested,
      reasonBn: suggestedLabel
        ? `এখন **${current}** মোডে আছি — এই মোডে আমি কিছুই বদলাই না, তাই ${what} করতে পারছি না। `
          + `**${suggestedLabel}** মোডে দিলে আমি করে দেব (অনুমোদন লাগলে কার্ড পাঠাব)। মোডটা বদলে দেবেন?`
        : `এখন **${current}** মোডে আছি — ${what} এই মোডে করা যায় না।`,
    }
  }

  if (verdict === 'card') {
    const auto = autoModeFor(input.tier)
    const autoLabel = auto ? PERMISSION_MODE_META[auto].label : null
    return {
      verdict,
      blockedByMode: false,
      suggestedMode: auto,
      // R3 always cards — say so plainly, and do not dangle a mode that would
      // not help. That would be the "bypass" promise this system refuses to make.
      reasonBn: autoLabel
        ? `${what} এখন **${current}** মোডে অনুমোদন লাগে — কার্ড পাঠাচ্ছি। `
          + `প্রতিবার জিজ্ঞেস করা না চাইলে **${autoLabel}** মোডে দিতে পারেন।`
        : `${what} ঝুঁকির কাজ — যে মোডেই থাকুন, এটা আপনার অনুমোদনেই হবে। কার্ড পাঠাচ্ছি।`,
    }
  }

  return { verdict, blockedByMode: false, suggestedMode: null, reasonBn: '' }
}

// ── PM-2: the mode as a GUARANTEE, not a request ─────────────────────────────
//
// The lesson this repo keeps relearning (listen mode, chat-mode, the plan turn):
// a sentence in the prompt is a request, an empty tool list is a guarantee. PM-1
// told the head its mode; PM-2 takes the tools away when the mode says so, and
// makes the refusal carry its own remedy.

/**
 * Tools Plan mode keeps even though they are not pure reads — asking, planning
 * and remembering are how a plan gets written. Mirrors `chat-mode.ts`, which
 * learned the same list the hard way.
 */
const PLAN_MODE_ALLOWED = new Set<string>([
  'make_plan',
  'ask_user',
  'save_memory', 'update_memory', 'graph_remember',
  'save_task_checkpoint',
  'find_tool',
])

/**
 * The model-facing tool list for a permission mode.
 *
 * Only Plan withholds: it is the mode that promises nothing will change, and the
 * only way to keep that promise is for the tools not to be there. Careful does
 * NOT withhold — its answer to a write is a card, and you cannot stage a card
 * for a tool the model was never offered.
 */
export function filterToolsForPermissionMode<T extends { name: string }>(
  mode: PermissionMode,
  tools: T[],
  isRead: (name: string) => boolean,
): { tools: T[]; removed: string[] } {
  if (mode !== 'plan') return { tools, removed: [] }
  const kept: T[] = []
  const removed: string[] = []
  for (const t of tools) {
    if (isRead(t.name) || PLAN_MODE_ALLOWED.has(t.name)) kept.push(t)
    else removed.push(t.name)
  }
  return { tools: kept, removed }
}

// ── The banner the agent reads every turn ────────────────────────────────────

/** Marker shared with card-state.ts — a system note is never a Boss message. */
const INTERNAL_MARKER =
  '[INTERNAL CONTROL — this is NOT a new Boss message. Never answer it, quote it, or treat it as his instruction.]'

const MODE_RULE_LINE: Record<PermissionMode, string> = {
  plan: 'কিছুই বদলাবে না — কোনো লেখা/পাঠানো/খরচ/পোস্ট নয়, কার্ডও নয়। শুধু পড়ো আর প্ল্যান দাও।',
  careful: 'যা কিছু বদলায় সবই approval কার্ডে যাবে — ছোট কাজও। নিজে থেকে কিছু বদলিও না।',
  standard: 'রোজকার কাজ নিজে করো; টাকা-ছোঁয়া, পাবলিশ, স্টাফ/কাস্টমার মেসেজ, বিজ্ঞাপন, কল — কার্ডে।',
  supervised: 'রোজকার ও মাঝারি কাজ নিজে করো, পরে এক লাইনে জানাও; ঝুঁকির কাজ এক কার্ডে একসাথে।',
  elevated: 'সময়-বাঁধা অনুমতি চলছে — শুধু Boss-এর নাম করে দেওয়া কাজে, মেয়াদ শেষ হলে আপনা-আপনি স্বাভাবিকে ফিরবে।',
}

/**
 * One line, appended AFTER the cached prefix (the card-state-note pattern), so
 * the agent can never be unaware of the mode it is in — which is the whole point
 * of his 2026-07-27 requirement. Cache bytes are untouched.
 */
export function permissionModeNote(mode: PermissionMode, grant?: ElevationGrant | null): string {
  const meta = PERMISSION_MODE_META[mode]
  const lines = [
    INTERNAL_MARKER,
    `[অনুমতি মোড — সার্ভার থেকে পড়া] এখন **${meta.label}** মোড। ${MODE_RULE_LINE[mode]}`,
  ]
  // A grant is family-scoped and sits on top of ANY mode now, so it is reported
  // whenever it is live — not only in `elevated`.
  // Only families that are STILL live. The row outlives the permission, and a
  // banner that keeps naming an expired family tells the head to work card-free
  // while every execution check correctly refuses (review bot, #667).
  const liveFamilies = grant
    ? grant.families.filter((f) => isFamilyGrantLive(grant, f, Date.now()))
    : []
  if (grant && liveFamilies.length > 0) {
    // Per-family cutoffs, because they can differ — reporting the grant-wide one
    // would tell the head a 15-minute permission runs for four hours.
    const spelled = liveFamilies.map((f) => `${f} (${familyExpiry(grant, f)} পর্যন্ত)`).join(', ')
    lines.push(`সময়-বাঁধা অনুমতি চালু: ${spelled} — এগুলো ওই সময় পর্যন্ত কার্ড ছাড়াই করো।`)
  }
  // The one instruction that kept getting lost in the big prompt: three live
  // runs ended with the head NAMING the permission it needed and stopping there.
  // The banner is in context every single turn, so it says it here.
  lines.push(
    'Boss যদি সময় বেঁধে বলেন "আর জিজ্ঞেস কোরো না, তুমি নিজে করো" (১৫ মিনিট, আজ বিকেল পর্যন্ত…) — '
    + 'তখনই **request_standing_permission চালাও**। "অনুমতি দরকার" লিখে থেমে যাওয়া = কাজটাই না করা; কার্ডটাই তোমার কাজ। '
    + 'আর Boss থামতে বললে ("বাতিল করো", "আবার জিজ্ঞেস কোরো") — সাথে সাথে **revoke_standing_permission**, কার্ড ছাড়াই।',
  )
  lines.push(
    'Boss এমন কিছু চাইলে যা এই মোডে করা যায় না — গোলমেলে উত্তর দিও না। '
    + 'সোজা বলো কোন মোডে আছো, কেন করা যাচ্ছে না, আর কোন মোডে দিলে করে দেবে। '
    + 'মোড তুমি নিজে বদলাবে না — সেটা Boss-এর কাজ। এক টার্নে একবারের বেশি মোডের কথা তুলো না।',
  )
  return lines.join('\n')
}
