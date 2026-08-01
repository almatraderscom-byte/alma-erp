/**
 * L8 (W2) — the daemon's own copy of the UI-driving classifier.
 *
 * THIS FILE IS A TWIN of `src/agent/lib/mac-agent/ui-policy.ts`. It exists so
 * the daemon can re-judge every synthetic click and keystroke locally, with no
 * build step and no trust in the server: a compromised or buggy server must
 * not be able to type into the owner's apps.
 *
 * **Edit both copies together.** `ui-policy-parity.test.ts` runs the same
 * corpus through both and fails the build on the first disagreement.
 *
 * The reasoning behind every rule lives in the TypeScript twin's header
 * comment; it is not duplicated here so the two cannot drift in prose either.
 */

export const UI_ACTIONS = [
  'ui_tree',
  'ui_screenshot',
  'ui_scroll',
  'ui_click',
  'ui_type',
  'ui_key',
]

const READ_ONLY_ACTIONS = new Set(['ui_tree', 'ui_screenshot', 'ui_scroll'])

export const ALLOWED_APPS = {
  'com.anthropic.claudefordesktop': 'Claude',
  'com.openai.chat': 'ChatGPT',
}

const FORBIDDEN_APPS = {
  'com.apple.terminal': { code: 'shell_bypass', bn: 'Terminal-এ টাইপ করে shell নিয়ম এড়ানো যাবে না।' },
  'com.googlecode.iterm2': { code: 'shell_bypass', bn: 'iTerm-এ টাইপ করে shell নিয়ম এড়ানো যাবে না।' },
  'com.apple.console': { code: 'shell_bypass', bn: 'Console অ্যাপ চালানো যাবে না।' },
  'com.apple.scripteditor2': { code: 'shell_bypass', bn: 'Script Editor দিয়ে স্ক্রিপ্ট চালানো যাবে না।' },
  'com.apple.keychainaccess': { code: 'credentials', bn: 'Keychain ছোঁয়া যাবে না।' },
  'com.apple.systempreferences': { code: 'system_settings', bn: 'System Settings বদলানো যাবে না।' },
  'com.apple.finder': { code: 'file_manager', bn: 'Finder দিয়ে ফাইল সরানো/মোছা যাবে না।' },
  'com.apple.mail': { code: 'outbound_message', bn: 'Mail থেকে মেইল পাঠানো এজেন্ট করবে না।' },
}

const RED_LABEL_RULES = [
  // A confirmation button is usually labelled with the VERB ALONE — see the
  // TS twin's comment for why a second noun was the wrong requirement.
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
    re: /\b(buy|purchase|pay|payment|checkout|subscribe|upgrade plan|add card|billing)\b/i,
    code: 'spends_money',
    bn: 'টাকা খরচের বোতাম — এজেন্ট চাপবে না, আপনি নিজে করবেন।',
  },
  { re: /\b(sign out|log out|logout)\b/i, code: 'session_loss', bn: 'লগআউট করলে আপনার সেশন হারাবে — এজেন্ট করবে না।' },
  {
    re: /^(allow|always allow|don'?t allow|grant|trust|authorize|authorise)\b/i,
    code: 'grants_permission',
    bn: 'অনুমতি দেওয়ার ডায়ালগ এজেন্ট নিজে মানবে না।',
  },
  { re: /\b(allow|grant|always allow)\b.*\b(access|permission)\b/i, code: 'grants_permission', bn: 'অনুমতি দেওয়ার ডায়ালগ এজেন্ট নিজে মানবে না।' },
]

/** Fields whose CONTENT is a secret whatever the text looks like. */
const SECRET_FIELD_LABEL = /\b(password|passphrase|passcode|secret|api[\s-]?key|token|otp|one[\s-]?time code|pin)\b/i

/** Keys that ACTIVATE whatever has focus — they inherit the label rules. */
const ACTIVATION_KEYS = /^(enter|return|space|cmd\+enter|cmd\+return|ctrl\+enter|ctrl\+return)$/i

/** How recently the owner must have used the machine for driving to be unsafe. */
export const OWNER_ACTIVE_WINDOW_SECONDS = 25

const SECRET_TEXT_RULES = [
  { re: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})/, code: 'secret_text', bn: 'API key/টোকেন টাইপ করা যাবে না।' },
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, code: 'secret_text', bn: 'প্রাইভেট কী টাইপ করা যাবে না।' },
  { re: /\b(password|passwd|passphrase)\s*[:=]\s*\S+/i, code: 'secret_text', bn: 'পাসওয়ার্ড টাইপ করা যাবে না।' },
]

const RED_KEYS = [
  { re: /^cmd\+q$/i, code: 'quits_app', bn: 'অ্যাপ বন্ধ করার শর্টকাট এজেন্ট চাপবে না।' },
  { re: /^cmd\+(shift\+)?delete$/i, code: 'destructive_key', bn: 'ডিলিট শর্টকাট এজেন্ট চাপবে না।' },
  { re: /^ctrl\+c$/i, code: 'destructive_key', bn: 'চলমান কাজ থামানোর শর্টকাট এজেন্ট চাপবে না।' },
]

export const UI_LIMITS = {
  maxTypeChars: 4_000,
  maxTreeChars: 60_000,
}

function normalizeBundleId(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

export function isAllowedApp(bundleId) {
  return Object.prototype.hasOwnProperty.call(ALLOWED_APPS, normalizeBundleId(bundleId))
}

export function appLabel(bundleId) {
  const id = normalizeBundleId(bundleId)
  return ALLOWED_APPS[id] ?? id ?? 'unknown'
}

export function classifyUiAction(req = {}) {
  const action = String(req.action ?? '').trim()
  if (!action) return { level: 'red', code: 'empty', reasonBn: 'কোনো অ্যাকশন দেওয়া হয়নি।' }
  if (!UI_ACTIONS.includes(action)) {
    return { level: 'red', code: 'unknown_action', reasonBn: `অজানা UI অ্যাকশন: ${action}` }
  }

  const bundleId = normalizeBundleId(req.bundleId)

  const forbidden = FORBIDDEN_APPS[bundleId]
  if (forbidden) return { level: 'red', code: forbidden.code, reasonBn: forbidden.bn }

  // ONLY a full-screen screenshot may omit the app — see the TS twin.
  const isRead = READ_ONLY_ACTIONS.has(action)
  if (!bundleId) {
    if (action === 'ui_screenshot') {
      return { level: 'green', code: 'read_only', reasonBn: 'শুধু দেখা — নিজে থেকেই হলো।' }
    }
    return { level: 'red', code: 'app_required', reasonBn: 'কোন অ্যাপে কাজটা হবে সেটা বলা হয়নি।' }
  }

  if (!isAllowedApp(bundleId)) {
    return {
      level: 'red',
      code: 'app_not_allowlisted',
      reasonBn: `এই অ্যাপে (${bundleId}) এজেন্ট কিছু করবে না — শুধু Claude আর ChatGPT অ্যাপ অনুমোদিত।`,
    }
  }

  if (isRead) {
    return { level: 'green', code: 'read_only', reasonBn: 'শুধু দেখা — নিজে থেকেই হলো।' }
  }

  // The owner is AT the keyboard — see the TS twin. `owner_active` is a DEFER
  // the daemon retries, RED only so nothing acts meanwhile.
  const idle = req.ownerIdleSeconds
  if (!Number.isFinite(idle) || idle < OWNER_ACTIVE_WINDOW_SECONDS) {
    return {
      level: 'red',
      code: 'owner_active',
      reasonBn: 'আপনি এখন কীবোর্ড/মাউসে আছেন — আপনার কাজের মাঝে এজেন্ট টাইপ করবে না, একটু পরে করবে।',
    }
  }

  const label = String(req.elementLabel ?? '').trim()
  if (label) {
    for (const rule of RED_LABEL_RULES) {
      if (rule.re.test(label)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }
  }

  if (action === 'ui_key') {
    const key = String(req.key ?? '').trim()
    if (!key) return { level: 'red', code: 'key_required', reasonBn: 'কোন কী চাপবে সেটা বলা হয়নি।' }
    for (const rule of RED_KEYS) {
      if (rule.re.test(key)) return { level: 'red', code: rule.code, reasonBn: rule.bn }
    }

    // An activation key presses whatever has focus — same label rules as a
    // click, and it fails closed without a resolved focus.
    if (ACTIVATION_KEYS.test(key)) {
      const focused = String(req.focusedLabel ?? '').trim()
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
    const text = String(req.text ?? '')
    if (!text.trim()) return { level: 'red', code: 'text_required', reasonBn: 'কী লিখবে সেটা বলা হয়নি।' }
    if (text.length > UI_LIMITS.maxTypeChars) {
      return { level: 'red', code: 'text_too_long', reasonBn: 'লেখাটা অস্বাভাবিক লম্বা — টাইপ করা হবে না।' }
    }
    // A real password carries no marker — the FIELD is what gives it away.
    if (label && SECRET_FIELD_LABEL.test(label)) {
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

  // ui_click — a missing label fails CLOSED; see the TS twin.
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

export function capTree(text) {
  if (text.length <= UI_LIMITS.maxTreeChars) return text
  return `${text.slice(0, UI_LIMITS.maxTreeChars)}\n…(tree বড় হওয়ায় কেটে দেওয়া হয়েছে)`
}
