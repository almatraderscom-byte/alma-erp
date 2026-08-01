/**
 * L8 (W2) — the safety core for DRIVING the owner's Mac apps.
 *
 * `policy.ts` decides what shell text may run. This decides what a synthetic
 * click or keystroke may do, because L8 gives the agent hands inside real
 * applications — his logged-in Claude and ChatGPT desktop apps.
 *
 *   GREEN — reading. The accessibility tree, a screenshot, a scroll. Nothing
 *           on the machine changes, so it runs by itself.
 *   AMBER — clicking and typing INSIDE an allowlisted app. The owner sees the
 *           app, the element and the literal text before anything happens.
 *   RED   — refused, not approvable. Any app off the allowlist, and a short
 *           list of surfaces where one tap is irreversible or steals secrets.
 *
 * Rules that matter more than the lists:
 *
 * 1. **Allowlist, never denylist.** An app the agent has never been reasoned
 *    about is RED by default. L8 ships with exactly two entries; widening
 *    needs a code change, review and a deploy — never an env var or KV row.
 * 2. **The GUI must not become a shell bypass.** Terminal, iTerm, Console and
 *    Script Editor are RED with their own reason code: typing `sudo rm -rf ~`
 *    into a terminal window would otherwise walk straight around policy.ts.
 * 3. **Destructive and money-spending controls are RED by their LABEL**, even
 *    inside an allowlisted app. "Delete account", "Buy", "Confirm payment" —
 *    a tap is a bad place to defend those.
 * 4. **Never type a secret.** Text that looks like a key, token or password is
 *    refused. The agent has no legitimate reason to type one, and a screen
 *    recording of the session would capture it.
 * 5. **This runs twice** — here before enqueueing, and again inside the daemon
 *    (`mac-agent/ui-policy.mjs`) before any event is synthesised. A parity
 *    test fails the build if the two copies drift.
 *
 * **Known boundary, stated honestly:** driving Claude desktop means asking
 * THAT Claude to do things, and it has its own approval gates. This module
 * governs the OS-level action (which app, which element, what text); the
 * app's own gate is the second layer. That is why an AMBER card always shows
 * the literal text being typed — the owner reads what is being asked before
 * it is asked.
 */

export type UiPolicyLevel = 'green' | 'amber' | 'red'

export interface UiPolicyVerdict {
  level: UiPolicyLevel
  /** Owner-readable Bangla reason — shown on the card or in the refusal. */
  reasonBn: string
  /** Stable machine reason for logs/tests. */
  code: string
}

/** UI verbs the daemon understands. Anything else is refused as unknown. */
export const UI_ACTIONS = [
  'ui_tree',
  'ui_screenshot',
  'ui_scroll',
  'ui_click',
  'ui_type',
  'ui_key',
] as const
export type UiAction = (typeof UI_ACTIONS)[number]

/** Purely observational verbs — they change nothing, so they run by themselves. */
const READ_ONLY_ACTIONS = new Set<string>(['ui_tree', 'ui_screenshot', 'ui_scroll'])

/**
 * The ONLY apps the agent may touch, by bundle id. Two entries on purpose:
 * these are the apps the owner asked for. Matching is exact and
 * case-insensitive; a human-readable name is never enough to decide (two apps
 * can both call themselves "Claude").
 */
export const ALLOWED_APPS: Readonly<Record<string, string>> = {
  'com.anthropic.claudefordesktop': 'Claude',
  'com.openai.chat': 'ChatGPT',
}

/**
 * Apps that are RED with a louder reason than "not on the list": each one is a
 * documented way to escape the sandbox this policy defines.
 */
const FORBIDDEN_APPS: Readonly<Record<string, { code: string; bn: string }>> = {
  'com.apple.terminal': { code: 'shell_bypass', bn: 'Terminal-এ টাইপ করে shell নিয়ম এড়ানো যাবে না।' },
  'com.googlecode.iterm2': { code: 'shell_bypass', bn: 'iTerm-এ টাইপ করে shell নিয়ম এড়ানো যাবে না।' },
  'com.apple.console': { code: 'shell_bypass', bn: 'Console অ্যাপ চালানো যাবে না।' },
  'com.apple.scripteditor2': { code: 'shell_bypass', bn: 'Script Editor দিয়ে স্ক্রিপ্ট চালানো যাবে না।' },
  'com.apple.keychainaccess': { code: 'credentials', bn: 'Keychain ছোঁয়া যাবে না।' },
  'com.apple.systempreferences': { code: 'system_settings', bn: 'System Settings বদলানো যাবে না।' },
  'com.apple.finder': { code: 'file_manager', bn: 'Finder দিয়ে ফাইল সরানো/মোছা যাবে না।' },
  'com.apple.mail': { code: 'outbound_message', bn: 'Mail থেকে মেইল পাঠানো এজেন্ট করবে না।' },
}

/**
 * Element labels that are irreversible or spend money. Checked inside
 * allowlisted apps too — the app being safe does not make its "Delete account"
 * button safe. Deliberately broad: a false RED costs the owner one manual
 * click, a false AMBER costs him data or money.
 */
const RED_LABEL_RULES: Array<{ re: RegExp; code: string; bn: string }> = [
  {
    re: /\b(delete|remove|erase|wipe|destroy|clear all|reset)\b.*\b(account|workspace|organization|all|everything|history|data)\b/i,
    code: 'destructive_label',
    bn: 'মুছে ফেলার মতো বোতামে এজেন্ট ক্লিক করবে না।',
  },
  { re: /\bdelete account\b|\bclose account\b|\bdeactivate\b/i, code: 'destructive_label', bn: 'অ্যাকাউন্ট মোছা/বন্ধ করার বোতাম — এজেন্ট চাপবে না।' },
  {
    re: /\b(buy|purchase|pay|payment|checkout|subscribe|upgrade plan|add card|billing)\b/i,
    code: 'spends_money',
    bn: 'টাকা খরচের বোতাম — এজেন্ট চাপবে না, আপনি নিজে করবেন।',
  },
  { re: /\b(sign out|log out|logout)\b/i, code: 'session_loss', bn: 'লগআউট করলে আপনার সেশন হারাবে — এজেন্ট করবে না।' },
  { re: /\b(allow|grant|always allow)\b.*\b(access|permission)\b/i, code: 'grants_permission', bn: 'অনুমতি দেওয়ার ডায়ালগ এজেন্ট নিজে মানবে না।' },
]

/**
 * Text the agent may never type. A key or password typed into a window is
 * visible in the live screen stream and in the app's own history.
 */
const SECRET_TEXT_RULES: Array<{ re: RegExp; code: string; bn: string }> = [
  { re: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/, code: 'secret_text', bn: 'API key/টোকেন টাইপ করা যাবে না।' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, code: 'secret_text', bn: 'প্রাইভেট কী টাইপ করা যাবে না।' },
  { re: /\b(password|passwd|passphrase)\s*[:=]\s*\S+/i, code: 'secret_text', bn: 'পাসওয়ার্ড টাইপ করা যাবে না।' },
]

/** Keystrokes that are destructive or escape the app, whatever the app is. */
const RED_KEYS: Array<{ re: RegExp; code: string; bn: string }> = [
  { re: /^cmd\+q$/i, code: 'quits_app', bn: 'অ্যাপ বন্ধ করার শর্টকাট এজেন্ট চাপবে না।' },
  { re: /^cmd\+(shift\+)?delete$/i, code: 'destructive_key', bn: 'ডিলিট শর্টকাট এজেন্ট চাপবে না।' },
  { re: /^ctrl\+c$/i, code: 'destructive_key', bn: 'চলমান কাজ থামানোর শর্টকাট এজেন্ট চাপবে না।' },
]

/** How much text may be typed in one action. Longer is refused, never truncated. */
export const UI_LIMITS = {
  maxTypeChars: 4_000,
  /** An AX tree dump beyond this is capped — it is headed for the head's context. */
  maxTreeChars: 60_000,
} as const

export interface UiActionRequest {
  action: string
  /** Bundle id of the target app. Required for everything except a full-screen read. */
  bundleId?: string
  /** Human label of the element being acted on, as read from the AX tree. */
  elementLabel?: string
  /** Literal text for `ui_type`. */
  text?: string
  /** Key combo for `ui_key`, e.g. "cmd+enter". */
  key?: string
}

function normalizeBundleId(raw?: string): string {
  return (raw ?? '').trim().toLowerCase()
}

/** Is this app one the agent may act inside? */
export function isAllowedApp(bundleId?: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_APPS, normalizeBundleId(bundleId))
}

/** Owner-facing app name, or the raw id when unknown. */
export function appLabel(bundleId?: string): string {
  const id = normalizeBundleId(bundleId)
  return ALLOWED_APPS[id] ?? id ?? 'unknown'
}

/**
 * The whole decision. Pure — no I/O, no clock, no model — so it is fully unit
 * testable and identical on the server and inside the daemon.
 */
export function classifyUiAction(req: UiActionRequest): UiPolicyVerdict {
  const action = (req.action ?? '').trim()
  if (!action) return { level: 'red', code: 'empty', reasonBn: 'কোনো অ্যাকশন দেওয়া হয়নি।' }
  if (!(UI_ACTIONS as readonly string[]).includes(action)) {
    return { level: 'red', code: 'unknown_action', reasonBn: `অজানা UI অ্যাকশন: ${action}` }
  }

  const bundleId = normalizeBundleId(req.bundleId)

  // 1. A forbidden app is refused before anything else, INCLUDING reads: we do
  //    not read the owner's Keychain window either.
  const forbidden = FORBIDDEN_APPS[bundleId]
  if (forbidden) return { level: 'red', code: forbidden.code, reasonBn: forbidden.bn }

  // 2. A full-screen read needs no app. Anything else must name one.
  const isRead = READ_ONLY_ACTIONS.has(action)
  if (!bundleId) {
    if (isRead) return { level: 'green', code: 'read_only', reasonBn: 'শুধু দেখা — নিজে থেকেই হলো।' }
    return { level: 'red', code: 'app_required', reasonBn: 'কোন অ্যাপে কাজটা হবে সেটা বলা হয়নি।' }
  }

  // 3. Off the allowlist = refused, for reads too. An app nobody reasoned about
  //    may be showing the owner's bank, his mail, or a password manager.
  if (!isAllowedApp(bundleId)) {
    return {
      level: 'red',
      code: 'app_not_allowlisted',
      reasonBn: `এই অ্যাপে (${bundleId}) এজেন্ট কিছু করবে না — শুধু Claude আর ChatGPT অ্যাপ অনুমোদিত।`,
    }
  }

  // 4. Inside an allowlisted app, reading is free.
  if (isRead) {
    return { level: 'green', code: 'read_only', reasonBn: 'শুধু দেখা — নিজে থেকেই হলো।' }
  }

  // 5. Destructive / money / permission labels are refused even here.
  const label = (req.elementLabel ?? '').trim()
  if (label) {
    for (const rule of RED_LABEL_RULES) {
      if (rule.re.test(label)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }
  }

  if (action === 'ui_key') {
    const key = (req.key ?? '').trim()
    if (!key) return { level: 'red', code: 'key_required', reasonBn: 'কোন কী চাপবে সেটা বলা হয়নি।' }
    for (const rule of RED_KEYS) {
      if (rule.re.test(key)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }
    return {
      level: 'amber',
      code: 'needs_approval',
      reasonBn: `${appLabel(bundleId)}-এ "${key}" চাপবো — আপনার অনুমতি লাগবে।`,
    }
  }

  if (action === 'ui_type') {
    const text = req.text ?? ''
    if (!text.trim()) return { level: 'red', code: 'text_required', reasonBn: 'কী লিখবে সেটা বলা হয়নি।' }
    if (text.length > UI_LIMITS.maxTypeChars) {
      return { level: 'red', code: 'text_too_long', reasonBn: 'লেখাটা অস্বাভাবিক লম্বা — টাইপ করা হবে না।' }
    }
    for (const rule of SECRET_TEXT_RULES) {
      if (rule.re.test(text)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }
    return {
      level: 'amber',
      code: 'needs_approval',
      reasonBn: `${appLabel(bundleId)}-এ লিখবো — আপনার অনুমতি লাগবে।`,
    }
  }

  // ui_click
  return {
    level: 'amber',
    code: 'needs_approval',
    reasonBn: label
      ? `${appLabel(bundleId)}-এ "${label}" চাপবো — আপনার অনুমতি লাগবে।`
      : `${appLabel(bundleId)}-এ ক্লিক করবো — আপনার অনুমতি লাগবে।`,
  }
}

/** Truncate an AX tree dump, telling the reader that it happened. */
export function capTree(text: string): string {
  if (text.length <= UI_LIMITS.maxTreeChars) return text
  return `${text.slice(0, UI_LIMITS.maxTreeChars)}\n…(tree বড় হওয়ায় কেটে দেওয়া হয়েছে)`
}
