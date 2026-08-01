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
 * Actions that SYNTHESISE input into whatever the owner is doing. Wider than
 * "needs approval": `ui_scroll` needs no card (reading a long chat would be
 * untappable otherwise) but it still moves his view, so it must wait for him
 * to step away. GREEN was only ever meant to say "no approval needed" — never
 * "safe to do while he is typing" (Codex on the W3 PR; my classification was
 * the root cause, not the driver).
 */
const SYNTHESISES_INPUT = new Set<string>(['ui_click', 'ui_type', 'ui_key', 'ui_scroll'])

/**
 * The ONLY apps the agent may touch, by bundle id. Two entries on purpose:
 * these are the apps the owner asked for. Matching is exact and
 * case-insensitive; a human-readable name is never enough to decide (two apps
 * can both call themselves "Claude").
 */
export const ALLOWED_APPS: Readonly<Record<string, string>> = {
  'com.anthropic.claudefordesktop': 'Claude',
  // ORDER IS LOAD-BEARING for the two ids that share a name: callers resolve a
  // friendly alias ("chatgpt") by taking the FIRST entry whose name matches,
  // so the id that is actually INSTALLED must come first. The shipping ChatGPT
  // desktop app is `com.openai.codex` (verified from
  // /Applications/ChatGPT.app's Info.plist on the owner's Mac 2026-08-02);
  // `com.openai.chat` is kept after it, allowlisted for other installs but
  // never the alias winner here.
  'com.openai.codex': 'ChatGPT',
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
  // A real confirmation button is usually labelled with the VERB ALONE —
  // "Delete", "Delete chat", "Allow". The explanatory sentence lives in a
  // separate AX element, so a rule that demanded a second noun from the same
  // label matched almost nothing that mattered (Codex round 2 on the W2 PR).
  // Anchored at the start so ordinary prose ("deleted 3 files") is unaffected.
  {
    re: /^(delete|remove|erase|wipe|destroy|discard|clear|reset|trash|revoke|unsubscribe)\b/i,
    code: 'destructive_label',
    bn: 'মুছে ফেলার মতো বোতামে এজেন্ট ক্লিক করবে না।',
  },
  {
    re: /\b(delete|remove|erase|wipe|destroy|clear all|reset)\b.*\b(account|workspace|organization|all|everything|history|data|chat|conversation|project)\b/i,
    code: 'destructive_label',
    bn: 'মুছে ফেলার মতো বোতামে এজেন্ট ক্লিক করবে না।',
  },
  { re: /\bdelete account\b|\bclose account\b|\bdeactivate\b/i, code: 'destructive_label', bn: 'অ্যাকাউন্ট মোছা/বন্ধ করার বোতাম — এজেন্ট চাপবে না।' },
  {
    re: /\b(buy|purchase|pay|payment|checkout|subscribe|upgrade|renew|add card|billing|invoice)\b/i,
    code: 'spends_money',
    bn: 'টাকা খরচের বোতাম — এজেন্ট চাপবে না, আপনি নিজে করবেন।',
  },
  { re: /\b(sign out|log out|logout)\b/i, code: 'session_loss', bn: 'লগআউট করলে আপনার সেশন হারাবে — এজেন্ট করবে না।' },
  // Native permission sheets say just "Allow" / "Don't Allow" / "OK".
  {
    re: /^(allow|always allow|don'?t allow|grant|trust|authorize|authorise)\b/i,
    code: 'grants_permission',
    bn: 'অনুমতি দেওয়ার ডায়ালগ এজেন্ট নিজে মানবে না।',
  },
  { re: /\b(allow|grant|always allow)\b.*\b(access|permission)\b/i, code: 'grants_permission', bn: 'অনুমতি দেওয়ার ডায়ালগ এজেন্ট নিজে মানবে না।' },
]

/**
 * Fields whose CONTENT is a secret regardless of what the text looks like. A
 * real password is just `hunter2` — it carries no marker — so the text rules
 * alone let a login form through (Codex round 2 on the W2 PR).
 */
const SECRET_FIELD_LABEL = /\b(password|passphrase|passcode|secret|api[\s-]?key|token|otp|one[\s-]?time code|pin)\b/i

/**
 * Keys that ACTIVATE whatever currently has focus. They can press the same
 * "Delete" button `ui_click` refuses, so they inherit the label rules and
 * require the daemon to resolve what is focused first.
 */
// Matched by the FINAL key under ANY modifier set: in Electron apps Enter can
// still activate the focused control while modifiers are held, so an exact
// allowlist let `shift+enter` skip the focused-label check (Codex round 5).
// Decided by the FINAL key under ANY prefix, not by a list of known modifier
// spellings: a caller writing `command+enter` or `meta+enter` would miss such
// a list and fall through to the unchecked AMBER path.
const ACTIVATION_KEYS = /(^|\+)(enter|return|space)$/i

/**
 * How recently the owner must have touched the keyboard or mouse for driving
 * to be unsafe. W1 hit this live: synthetic keystrokes land in whatever the
 * owner is typing into. Reads are unaffected — only actions that move things.
 */
export const OWNER_ACTIVE_WINDOW_SECONDS = 25

/**
 * Text the agent may never type. A key or password typed into a window is
 * visible in the live screen stream and in the app's own history.
 */
const SECRET_TEXT_RULES: Array<{ re: RegExp; code: string; bn: string }> = [
  { re: /\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/, code: 'secret_text', bn: 'API key/টোকেন টাইপ করা যাবে না।' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, code: 'secret_text', bn: 'প্রাইভেট কী টাইপ করা যাবে না।' },
  { re: /\b(password|passwd|passphrase)\s*[:=]\s*\S+/i, code: 'secret_text', bn: 'পাসওয়ার্ড টাইপ করা যাবে না।' },
]

/** Keystrokes that are destructive or escape the app, whatever the app is. */
const RED_KEYS: Array<{ re: RegExp; code: string; bn: string }> = [
  { re: /^cmd\+q$/i, code: 'quits_app', bn: 'অ্যাপ বন্ধ করার শর্টকাট এজেন্ট চাপবে না।' },
  { re: /^(?=.*\bcmd\b).*\+(delete|backspace)$/i, code: 'destructive_key', bn: 'ডিলিট শর্টকাট এজেন্ট চাপবে না।' },
  { re: /^ctrl\+c$/i, code: 'destructive_key', bn: 'চলমান কাজ থামানোর শর্টকাট এজেন্ট চাপবে না।' },
  /**
   * OS-GLOBAL combinations. These ignore which app is frontmost, so naming an
   * allowlisted app buys nothing — `cmd+opt+shift+q` logs the owner straight
   * out (Codex round 3 on the W2 PR). Modifier order is not fixed by the
   * caller, so each is matched as a SET of modifiers plus the final key.
   */
  { re: /^(?=.*\bcmd\b)(?=.*\b(opt|option|alt)\b)(?=.*\bshift\b).*\+q$/i, code: 'session_loss', bn: 'লগআউট শর্টকাট — এজেন্ট চাপবে না।' },
  { re: /^(?=.*\bctrl\b)(?=.*\bcmd\b).*\+q$/i, code: 'session_loss', bn: 'স্ক্রিন লক/লগআউট শর্টকাট — এজেন্ট চাপবে না।' },
  { re: /^(?=.*\bcmd\b)(?=.*\b(opt|option|alt)\b).*\+(esc|escape)$/i, code: 'destructive_key', bn: 'Force Quit শর্টকাট — এজেন্ট চাপবে না।' },
  { re: /^(?=.*\bctrl\b)(?=.*\b(power|eject)\b)/i, code: 'power', bn: 'পাওয়ার/শাটডাউন শর্টকাট — এজেন্ট চাপবে না।' },
  { re: /^(?=.*\bcmd\b)(?=.*\bctrl\b)(?=.*\b(opt|option|alt)\b).*\+(power|eject)$/i, code: 'power', bn: 'পাওয়ার শর্টকাট — এজেন্ট চাপবে না।' },
]

/**
 * Modifier spellings callers actually use, folded to one canonical form
 * BEFORE any key rule runs. Accepting `command+enter` as an activation while
 * `command+q` slipped past the quit rule was exactly this gap (Codex round 6).
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  command: 'cmd',
  meta: 'cmd',
  super: 'cmd',
  control: 'ctrl',
  option: 'opt',
  alt: 'opt',
  del: 'delete',
  esc: 'escape',
  spacebar: 'space',
}

/** Canonical key string: lowercased, trimmed, aliases folded. */
export function normalizeKey(raw: string): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => KEY_ALIASES[part] ?? part)
    .join('+')
}

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
  /**
   * Label of the element that currently HAS FOCUS, resolved by the daemon.
   * Required for activation keys — without it, `enter` is a blind click.
   */
  focusedLabel?: string
  /**
   * Seconds since the owner last touched the keyboard or mouse, measured by
   * the daemon. Omitted means "unknown", which fails closed for actions.
   */
  ownerIdleSeconds?: number
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

  // 2. ONLY a full-screen screenshot may omit the app. `ui_tree` and
  //    `ui_scroll` without one would fall through to whatever is frontmost —
  //    which is how an unnamed read becomes a read of the Keychain window
  //    (Codex on the W2 PR). Everything else must name its app.
  const isRead = READ_ONLY_ACTIONS.has(action)
  if (!bundleId) {
    if (action === 'ui_screenshot') {
      return { level: 'green', code: 'read_only', reasonBn: 'শুধু দেখা — নিজে থেকেই হলো।' }
    }
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
  // The owner is AT the keyboard. Anything that synthesises input — including
  // a scroll, which needs no card but still moves his view — waits until he
  // steps away. `owner_active` is a DEFER the daemon retries, RED only so
  // nothing acts meanwhile. Unknown idle time fails closed.
  if (SYNTHESISES_INPUT.has(action)) {
    const idleNow = req.ownerIdleSeconds
    if (!Number.isFinite(idleNow) || (idleNow as number) < OWNER_ACTIVE_WINDOW_SECONDS) {
      return {
        level: 'red',
        code: 'owner_active',
        reasonBn: 'আপনি এখন কীবোর্ড/মাউসে আছেন — আপনার কাজের মাঝে এজেন্ট কিছু করবে না, একটু পরে করবে।',
      }
    }
  }

  if (isRead) {
    return { level: 'green', code: 'read_only', reasonBn: 'শুধু দেখা — নিজে থেকেই হলো।' }
  }

  // 6. Destructive / money / permission labels are refused even here.
  const label = (req.elementLabel ?? '').trim()
  if (label) {
    for (const rule of RED_LABEL_RULES) {
      if (rule.re.test(label)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }
  }

  if (action === 'ui_key') {
    const key = normalizeKey(req.key ?? '')
    if (!key) return { level: 'red', code: 'key_required', reasonBn: 'কোন কী চাপবে সেটা বলা হয়নি।' }
    for (const rule of RED_KEYS) {
      if (rule.re.test(key)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }

    // An activation key presses whatever has focus — it can hit the very
    // "Delete" button `ui_click` refuses. So it needs the same label check,
    // against the FOCUSED element, and fails closed without one.
    if (ACTIVATION_KEYS.test(key)) {
      const focused = (req.focusedLabel ?? '').trim()
      if (!focused) {
        return {
          level: 'red',
          code: 'focus_required',
          reasonBn: 'ফোকাসে কী আছে জানা যায়নি — Enter/Space অন্ধভাবে চাপা হবে না।',
        }
      }
      for (const rule of RED_LABEL_RULES) {
        if (rule.re.test(focused)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
      }
      return {
        level: 'amber',
        code: 'needs_approval',
        reasonBn: `${appLabel(bundleId)}-এ "${focused}"-এ "${key}" চাপবো — আপনার অনুমতি লাগবে।`,
      }
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
    // The FIELD is what gives a secret away — a real password is just
    // `hunter2`. So typing without a resolved field label fails CLOSED, the
    // same laundering path already shut for clicks (Codex round 3).
    if (!label) {
      return {
        level: 'red',
        code: 'label_required',
        reasonBn: 'কোন ঘরে লেখা হবে সেটা জানা যায়নি — নাম ছাড়া টাইপ করা হবে না।',
      }
    }
    if (SECRET_FIELD_LABEL.test(label)) {
      return { level: 'red', code: 'secret_field', reasonBn: 'পাসওয়ার্ড/কী-এর ঘরে এজেন্ট কিছু লিখবে না।' }
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

  // ui_click — the label IS the safety check, so a missing one fails CLOSED.
  // Without this, dropping `elementLabel` turned a RED "Delete account" into a
  // vague approvable click, defeating both the rule and the owner's ability to
  // see what he is approving (Codex on the W2 PR).
  if (!label) {
    return {
      level: 'red',
      code: 'label_required',
      reasonBn: 'কোন বোতামে ক্লিক হবে সেটা জানা যায়নি — নাম ছাড়া ক্লিক করা হবে না।',
    }
  }
  return {
    level: 'amber',
    code: 'needs_approval',
    reasonBn: `${appLabel(bundleId)}-এ "${label}" চাপবো — আপনার অনুমতি লাগবে।`,
  }
}

/**
 * A structural fingerprint of every rule this module enforces.
 *
 * The parity corpus can only prove the cases someone thought to write down —
 * adding a rule to ONE twin and forgetting the other stayed green because no
 * corpus entry happened to hit it (Codex round 3 on the W2 PR). Comparing the
 * digests makes any divergence in the rule SETS themselves a red build, which
 * is the property the twin arrangement actually depends on.
 *
 * Regexes are compared by source + flags: identical behaviour, textually
 * verifiable, and stable to serialise.
 */
export const POLICY_RULE_DIGEST = {
  readOnlyActions: [...READ_ONLY_ACTIONS].sort(),
  synthesisesInput: [...SYNTHESISES_INPUT].sort(),
  allowedApps: ALLOWED_APPS,
  forbiddenApps: FORBIDDEN_APPS,
  redLabelRules: RED_LABEL_RULES.map((r) => ({ code: r.code, bn: r.bn, source: r.re.source, flags: r.re.flags })),
  secretTextRules: SECRET_TEXT_RULES.map((r) => ({ code: r.code, bn: r.bn, source: r.re.source, flags: r.re.flags })),
  redKeys: RED_KEYS.map((r) => ({ code: r.code, bn: r.bn, source: r.re.source, flags: r.re.flags })),
  secretFieldLabel: { source: SECRET_FIELD_LABEL.source, flags: SECRET_FIELD_LABEL.flags },
  activationKeys: { source: ACTIVATION_KEYS.source, flags: ACTIVATION_KEYS.flags },
  keyAliases: KEY_ALIASES,
  limits: { ...UI_LIMITS },
  ownerActiveWindowSeconds: OWNER_ACTIVE_WINDOW_SECONDS,
} as const

/**
 * Truncate an AX tree dump, telling the reader that it happened. Keeps the
 * TAIL: in both target apps the composer and the newest conversation text sit
 * at the BOTTOM of the tree, so a head-keeping cap cut exactly the content a
 * full read exists to fetch (Codex P2 on the L8 demo round).
 */
export function capTree(text: string): string {
  if (text.length <= UI_LIMITS.maxTreeChars) return text
  return `…(tree বড় হওয়ায় শুরুটা কেটে দেওয়া হয়েছে)\n${text.slice(-UI_LIMITS.maxTreeChars)}`
}
