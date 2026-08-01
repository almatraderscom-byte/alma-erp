/**
 * The daemon ships its own copy of the UI classifier (mac-agent/ui-policy.mjs)
 * so it keeps working with no build step and — more importantly — so the
 * server cannot remotely widen what the agent may click or type inside the
 * owner's apps.
 *
 * A copy is only safe if it cannot drift. This runs both implementations over
 * the same corpus and fails on the first disagreement, which makes "I edited
 * one side and forgot the other" a red build instead of a silent hole.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyUiAction as classifyTs,
  ALLOWED_APPS as ALLOWED_TS,
  UI_ACTIONS as ACTIONS_TS,
  UI_LIMITS as LIMITS_TS,
  OWNER_ACTIVE_WINDOW_SECONDS as IDLE_TS,
  POLICY_RULE_DIGEST as DIGEST_TS,
} from '../ui-policy'
// Plain ESM sibling shipped with the daemon — no types by design.
import {
  classifyUiAction as classifyMjs,
  ALLOWED_APPS as ALLOWED_MJS,
  UI_ACTIONS as ACTIONS_MJS,
  UI_LIMITS as LIMITS_MJS,
  OWNER_ACTIVE_WINDOW_SECONDS as IDLE_MJS,
  POLICY_RULE_DIGEST as DIGEST_MJS,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — untyped daemon twin
} from '../../../../../mac-agent/ui-policy.mjs'

const CLAUDE = 'com.anthropic.claudefordesktop'
const CHATGPT = 'com.openai.chat'
/** Driving actions only run while the owner is away — the default for the corpus. */
const AWAY = { ownerIdleSeconds: 120 }

/** Every case that matters, in one place, exercised against both copies. */
const CORPUS: Array<Record<string, unknown>> = [
  // green
  { action: 'ui_tree', bundleId: CLAUDE },
  { action: 'ui_screenshot', bundleId: CHATGPT },
  { action: 'ui_scroll', bundleId: CLAUDE },
  { action: 'ui_screenshot' },
  // amber
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Send' },
  { ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'New chat' },
  { ...AWAY, action: 'ui_type', bundleId: CHATGPT, text: 'orders page er bug ta dekho' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+enter' },
  { ...AWAY, action: 'ui_key', bundleId: CHATGPT, key: 'enter' },
  // red — apps
  { action: 'ui_tree', bundleId: 'com.apple.safari' },
  { ...AWAY, action: 'ui_type', bundleId: 'com.apple.terminal', text: 'sudo rm -rf ~' },
  { ...AWAY, action: 'ui_click', bundleId: 'com.googlecode.iterm2' },
  { action: 'ui_tree', bundleId: 'com.apple.keychainaccess' },
  { ...AWAY, action: 'ui_click', bundleId: 'com.apple.systempreferences' },
  { ...AWAY, action: 'ui_click', bundleId: 'com.apple.finder' },
  { ...AWAY, action: 'ui_click', bundleId: 'com.apple.mail' },
  // red — labels
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Delete account' },
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Clear all history' },
  { ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Upgrade plan' },
  { ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Buy credits' },
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Log out' },
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Always allow access' },
  // red — text and keys
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: 'sk-abcdefghijklmnopqrstuvwxyz123456' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: 'password: hunter2' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: '-----BEGIN RSA PRIVATE KEY-----' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: 'x'.repeat(5_000) },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: '  ' },
  // A click with no resolved label must fail closed on both sides.
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE },
  // Reads that omit the app: only a screenshot may.
  { action: 'ui_tree' },
  { action: 'ui_scroll' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+q' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+shift+delete' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: '' },
  // red — malformed
  { ...AWAY, action: 'ui_click' },
  { action: 'ui_drag', bundleId: CLAUDE },
  { action: '' },
  // owner-at-keyboard, unknown idle, and the round-2 label/focus/field rules
  { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Send', ownerIdleSeconds: 1 },
  { action: 'ui_type', bundleId: CLAUDE, text: 'hi' },
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Delete' },
  { ...AWAY, action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Allow' },
  { ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Trust' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Password', text: 'hunter2' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'API key', text: 'abc123' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'enter' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'enter', focusedLabel: 'Delete' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+enter', focusedLabel: 'Prompt' },
  { ...AWAY, action: 'ui_key', bundleId: CHATGPT, key: 'space', focusedLabel: 'Allow' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+a' },
  // round-3: OS-global shortcuts and unlabelled typing
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+opt+shift+q' },
  { ...AWAY, action: 'ui_key', bundleId: CHATGPT, key: 'ctrl+cmd+q' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+option+esc' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: 'hunter2' },
  // round-4: upgrade CTAs, fine-grained tokens, modifier order
  { ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Upgrade' },
  { ...AWAY, action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Upgrade to Pro' },
  { ...AWAY, action: 'ui_type', bundleId: CLAUDE, elementLabel: 'Message', text: 'github_pat_11ABCDEFG0abcdefghijklmnop' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'shift+cmd+delete' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+backspace' },
  // round-5: modified Enter still activates a focused control — including
  // modifier spellings no allowlist would have contained.
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'shift+enter' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'cmd+shift+enter', focusedLabel: 'Delete' },
  { ...AWAY, action: 'ui_key', bundleId: CHATGPT, key: 'opt+return', focusedLabel: 'Do anything' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'command+enter' },
  { ...AWAY, action: 'ui_key', bundleId: CLAUDE, key: 'meta+space' },
  // case-insensitivity must agree on both sides
  { ...AWAY, action: 'ui_click', bundleId: 'COM.OPENAI.CHAT', elementLabel: 'Send' },
]

describe('UI policy parity — server and daemon must agree exactly', () => {
  it('agrees on the allowlist itself', () => {
    expect(ALLOWED_MJS).toEqual(ALLOWED_TS)
  })

  it('agrees on the known action list', () => {
    expect([...ACTIONS_MJS]).toEqual([...ACTIONS_TS])
  })

  /**
   * The corpus alone cannot catch a widened LIMIT: a fixed 5,000-char case
   * stays RED on both sides even if one twin quietly moved maxTypeChars from
   * 4,000 to 4,500, while a 4,250-char request would get contradictory
   * verdicts (Codex on the W2 PR). Compare the numbers, and probe the exact
   * boundary derived from each copy's OWN value.
   */
  it('agrees on the policy limits themselves', () => {
    expect({ ...LIMITS_MJS }).toEqual({ ...LIMITS_TS })
  })

  it('agrees on the owner-active window', () => {
    expect(IDLE_MJS).toBe(IDLE_TS)
  })

  /**
   * The strongest gate: the corpus can only prove cases somebody wrote down,
   * so a rule added to ONE twin stayed green when no entry happened to hit it
   * (Codex round 3). Comparing the rule SETS structurally makes any
   * divergence a red build — including rules nobody has written a case for.
   */
  it('agrees on every rule set, not just the cases in the corpus', () => {
    expect(JSON.parse(JSON.stringify(DIGEST_MJS))).toEqual(JSON.parse(JSON.stringify(DIGEST_TS)))
  })

  it('agrees at each copy’s own owner-active boundary', () => {
    for (const threshold of [IDLE_TS, IDLE_MJS as number]) {
      for (const idle of [threshold - 1, threshold]) {
        const req = { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Send', ownerIdleSeconds: idle }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = classifyTs(req as any)
        const mjs = classifyMjs(req)
        expect({ level: mjs.level, code: mjs.code }).toEqual({ level: ts.level, code: ts.code })
      }
    }
  })

  it('agrees at each copy’s own maxTypeChars boundary', () => {
    for (const limit of [LIMITS_TS.maxTypeChars, LIMITS_MJS.maxTypeChars as number]) {
      for (const len of [limit, limit + 1]) {
        const req = { ...AWAY, action: 'ui_type', bundleId: CLAUDE, text: 'x'.repeat(len) }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ts = classifyTs(req as any)
        const mjs = classifyMjs(req)
        expect({ level: mjs.level, code: mjs.code }).toEqual({ level: ts.level, code: ts.code })
      }
    }
  })

  for (const req of CORPUS) {
    const name = `${req.action || '(empty)'} · ${req.bundleId ?? 'no-app'} · ${
      String(req.elementLabel ?? req.key ?? req.text ?? '').slice(0, 24) || '—'
    }`
    it(`agrees on: ${name}`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ts = classifyTs(req as any)
      const mjs = classifyMjs(req)
      expect({ level: mjs.level, code: mjs.code, reasonBn: mjs.reasonBn }).toEqual({
        level: ts.level,
        code: ts.code,
        reasonBn: ts.reasonBn,
      })
    })
  }
})
