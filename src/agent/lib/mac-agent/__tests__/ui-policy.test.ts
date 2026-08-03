/**
 * L8 (W2) — what the UI classifier must refuse, ask about, and allow.
 *
 * These are the cases that decide whether giving the agent hands inside the
 * owner's apps is safe. The shape mirrors `policy.test.ts`: every RED case is
 * a hole someone could otherwise walk through.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyUiAction,
  isAllowedApp,
  capTree,
  UI_LIMITS,
  OWNER_ACTIVE_WINDOW_SECONDS,
  ALLOWED_APPS,
} from '../ui-policy'

/** The owner has stepped away — the precondition for any driving action. */
const AWAY = { ownerIdleSeconds: OWNER_ACTIVE_WINDOW_SECONDS + 5 }

const CLAUDE = 'com.anthropic.claudefordesktop'
const CHATGPT = 'com.openai.chat'

describe('UI policy — GREEN (reading changes nothing)', () => {
  it('reads the tree of an allowlisted app by itself', () => {
    expect(classifyUiAction({ action: 'ui_tree', bundleId: CLAUDE }).level).toBe('green')
  })

  it('screenshots without asking', () => {
    expect(classifyUiAction({ action: 'ui_screenshot', bundleId: CHATGPT }).level).toBe('green')
  })

  it('scrolls without a card — but only once the owner has stepped away', () => {
    // Scrolling needs no approval (reading a long chat would be untappable),
    // yet it synthesises input into his view, so it waits like the rest.
    expect(classifyUiAction({ ...AWAY, action: 'ui_scroll', bundleId: CHATGPT }).level).toBe('green')
    expect(classifyUiAction({ action: 'ui_scroll', bundleId: CHATGPT, ownerIdleSeconds: 2 }).code).toBe('owner_active')
    expect(classifyUiAction({ action: 'ui_scroll', bundleId: CHATGPT }).code).toBe('owner_active')
  })

  it('allows a full-screen read with no app named', () => {
    expect(classifyUiAction({ action: 'ui_screenshot' }).level).toBe('green')
  })

  it('but ONLY a screenshot may omit the app — tree/scroll would read the frontmost window', () => {
    expect(classifyUiAction({ action: 'ui_tree' }).code).toBe('app_required')
    expect(classifyUiAction({ action: 'ui_scroll' }).code).toBe('app_required')
  })
})

describe('UI policy — AMBER (acting inside an allowed app)', () => {
  it('asks before clicking, and names the element', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Send' })
    expect(v.level).toBe('amber')
    expect(v.reasonBn).toContain('Claude')
    expect(v.reasonBn).toContain('Send')
  })

  it('refuses a click with no resolved label — dropping it must not launder a RED target', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE })
    expect(v.level).toBe('red')
    expect(v.code).toBe('label_required')
  })

  it('asks before typing, and names the app', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CHATGPT, elementLabel: 'Message', text: 'hello' })
    expect(v.level).toBe('amber')
    expect(v.reasonBn).toContain('ChatGPT')
  })

  it('asks before a non-activating key combo', () => {
    expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+a' }).level).toBe('amber')
  })

  it('asks before an activation key once focus is resolved, and names the control', () => {
    const v = classifyUiAction({
      ...AWAY,
      action: 'ui_key',
      bundleId: CLAUDE,
      key: 'cmd+enter',
      focusedLabel: 'Prompt',
    })
    expect(v.level).toBe('amber')
    expect(v.reasonBn).toContain('Prompt')
  })
})

describe('UI policy — the owner is at the keyboard', () => {
  it('defers every driving action while he is active', () => {
    for (const req of [
      { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Send' },
      { action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Prompt', text: 'hello' },
      { action: 'ui_key', bundleId: CLAUDE, key: 'cmd+a' },
    ]) {
      const v = classifyUiAction({ ...req, ownerIdleSeconds: 2 })
      expect(v.level).toBe('red')
      expect(v.code).toBe('owner_active')
    }
  })

  it('fails closed when idle time is unknown', () => {
    expect(classifyUiAction({ action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Prompt', text: 'hi' }).code).toBe('owner_active')
  })

  it('still allows PURE reading while he works — watching never interrupts', () => {
    expect(classifyUiAction({ action: 'ui_tree', bundleId: CLAUDE, ownerIdleSeconds: 0 }).level).toBe('green')
    expect(classifyUiAction({ action: 'ui_screenshot', bundleId: CLAUDE, ownerIdleSeconds: 0 }).level).toBe('green')
  })
})

describe('UI policy — RED (never approvable)', () => {
  it('refuses any app that is not on the allowlist, even for reads', () => {
    const v = classifyUiAction({ action: 'ui_tree', bundleId: 'com.apple.safari' })
    expect(v.level).toBe('red')
    expect(v.code).toBe('app_not_allowlisted')
  })

  it('refuses terminals — the GUI must not become a shell bypass', () => {
    for (const id of ['com.apple.terminal', 'com.googlecode.iterm2', 'com.apple.scripteditor2']) {
      const v = classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: id, elementLabel: 'Terminal', text: 'sudo rm -rf ~' })
      expect(v.level).toBe('red')
      expect(v.code).toBe('shell_bypass')
    }
  })

  it('refuses Keychain, System Settings, Finder and Mail', () => {
    expect(classifyUiAction({ action: 'ui_tree', bundleId: 'com.apple.keychainaccess' }).code).toBe('credentials')
    expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: 'com.apple.systempreferences' }).code).toBe('system_settings')
    expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: 'com.apple.finder' }).code).toBe('file_manager')
    expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: 'com.apple.mail' }).code).toBe('outbound_message')
  })

  it('refuses destructive labels INSIDE an allowed app', () => {
    for (const label of ['Delete account', 'Clear all history', 'Deactivate']) {
      const v = classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: label })
      expect(v.level).toBe('red')
    }
  })

  it('refuses money buttons inside an allowed app', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Upgrade plan' })
    expect(v.level).toBe('red')
    expect(v.code).toBe('spends_money')
  })

  it('refuses logging the owner out', () => {
    expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Log out' }).code).toBe('session_loss')
  })

  it('refuses accepting permission dialogs on the owner’s behalf', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Always allow access' })
    expect(v.code).toBe('grants_permission')
  })

  it('never types a secret', () => {
    const cases = [
      'sk-abcdefghijklmnopqrstuvwxyz123456',
      'ghp_abcdefghijklmnopqrstuvwxyz123456',
      '-----BEGIN RSA PRIVATE KEY-----',
      'password: hunter2',
    ]
    for (const text of cases) {
      const v = classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Prompt', text })
      expect(v.level).toBe('red')
      expect(v.code).toBe('secret_text')
    }
  })

  it('folds modifier aliases before judging — command/meta/option must not slip past', () => {
    for (const key of ['command+q', 'meta+q', 'command+delete', 'command+option+shift+q', 'control+command+q']) {
      const v = classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key })
      expect(v.level).toBe('red')
    }
  })

  it('refuses destructive keystrokes', () => {
    expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+q' }).level).toBe('red')
    expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+shift+delete' }).level).toBe('red')
  })

  it('refuses Enter/Space when what has focus is unknown — a blind activation', () => {
    for (const key of ['enter', 'space', 'cmd+enter']) {
      expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key }).code).toBe('focus_required')
    }
  })

  it('treats Enter as an activation under ANY modifier set — modifiers do not skip the focus rules', () => {
    for (const key of ['shift+enter', 'cmd+shift+enter', 'command+enter', 'meta+space', 'opt+return', 'ctrl+shift+space', 'fn+enter']) {
      expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key }).code).toBe('focus_required')
      expect(
        classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key, focusedLabel: 'Delete' }).code,
      ).toBe('destructive_label')
    }
  })

  it('refuses Enter on a focused destructive/payment control — the ui_click rules apply to keys too', () => {
    expect(
      classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'enter', focusedLabel: 'Delete' }).code,
    ).toBe('destructive_label')
    expect(
      classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CHATGPT, key: 'space', focusedLabel: 'Allow' }).code,
    ).toBe('grants_permission')
  })

  it('refuses standalone confirmation labels — a real button says only the verb', () => {
    for (const label of ['Delete', 'Delete chat', 'Remove', 'Reset', 'Discard']) {
      expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: label }).code).toBe(
        'destructive_label',
      )
    }
    for (const label of ['Allow', 'Always Allow', 'Trust']) {
      expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: label }).code).toBe(
        'grants_permission',
      )
    }
  })

  it('refuses upgrade CTAs whatever the product suffix', () => {
    for (const label of ['Upgrade', 'Upgrade to Pro', 'Upgrade plan', 'Renew subscription']) {
      expect(classifyUiAction({ ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: label }).code).toBe(
        'spends_money',
      )
    }
  })

  it('refuses fine-grained GitHub tokens, not just the legacy format', () => {
    for (const text of ['github_pat_11ABCDEFG0abcdefghijklmnop', 'gho_abcdefghijklmnopqrstuvwxyz01']) {
      expect(
        classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Message', text }).code,
      ).toBe('secret_text')
    }
  })

  it('refuses destructive shortcuts in ANY modifier order', () => {
    for (const key of ['cmd+shift+delete', 'shift+cmd+delete', 'cmd+delete', 'cmd+backspace']) {
      expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key }).level).toBe('red')
    }
  })

  it('refuses OS-global shortcuts that ignore which app is frontmost', () => {
    for (const key of ['cmd+opt+shift+q', 'ctrl+cmd+q', 'cmd+option+esc']) {
      const v = classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key })
      expect(v.level).toBe('red')
    }
  })

  it('refuses typing with no resolved field label — the same laundering path as clicks', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: 'hunter2' })
    expect(v.level).toBe('red')
    expect(v.code).toBe('label_required')
  })

  it('never types into a secret FIELD, however ordinary the text looks', () => {
    for (const field of ['Password', 'Passphrase', 'API key', 'One-time code']) {
      const v = classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: field, text: 'hunter2' })
      expect(v.level).toBe('red')
      expect(v.code).toBe('secret_field')
    }
  })

  it('refuses an action with no app when the action changes something', () => {
    expect(classifyUiAction({ ...AWAY, action: 'ui_click' }).code).toBe('app_required')
  })

  it('refuses unknown actions and empty input', () => {
    expect(classifyUiAction({ action: 'ui_drag', bundleId: CLAUDE }).code).toBe('unknown_action')
    expect(classifyUiAction({ action: '' }).code).toBe('empty')
  })

  it('refuses absurdly long typing instead of truncating it', () => {
    const v = classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Prompt', text: 'x'.repeat(UI_LIMITS.maxTypeChars + 1) })
    expect(v.code).toBe('text_too_long')
  })

  it('refuses empty text / missing key', () => {
    expect(classifyUiAction({ ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Prompt', text: '   ' }).code).toBe('text_required')
    expect(classifyUiAction({ ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: '' }).code).toBe('key_required')
  })
})

describe('UI policy — helpers', () => {
  it('resolves the ChatGPT alias to the INSTALLED id — order in ALLOWED_APPS is load-bearing', () => {
    // Callers turn a friendly name into an id by taking the first entry whose
    // label matches; picking com.openai.chat would target an app that is not
    // installed, so the driver would find no window.
    const firstChatGpt = Object.entries(ALLOWED_APPS).find(([, name]) => name === 'ChatGPT')?.[0]
    expect(firstChatGpt).toBe('com.openai.codex')
  })

  it('allows the real ChatGPT bundle id — the shipping app is com.openai.codex', () => {
    expect(isAllowedApp('com.openai.codex')).toBe(true)
    const v = classifyUiAction({
      ...AWAY,
      action: 'ui_click',
      bundleId: 'com.openai.codex',
      elementLabel: 'New chat',
    })
    expect(v.level).toBe('amber')
    expect(v.reasonBn).toContain('ChatGPT')
  })

  it('matches bundle ids case-insensitively but exactly', () => {
    expect(isAllowedApp('COM.OPENAI.CHAT')).toBe(true)
    expect(isAllowedApp('com.openai.chat.evil')).toBe(false)
    expect(isAllowedApp(undefined)).toBe(false)
  })

  it('caps an oversized tree with a visible marker', () => {
    const capped = capTree('y'.repeat(UI_LIMITS.maxTreeChars + 50))
    expect(capped.length).toBeLessThan(UI_LIMITS.maxTreeChars + 50)
    expect(capped).toContain('কেটে দেওয়া হয়েছে')
  })
})
