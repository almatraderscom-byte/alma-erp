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
import { classifyUiAction as classifyTs, ALLOWED_APPS as ALLOWED_TS, UI_ACTIONS as ACTIONS_TS } from '../ui-policy'
// Plain ESM sibling shipped with the daemon — no types by design.
import {
  classifyUiAction as classifyMjs,
  ALLOWED_APPS as ALLOWED_MJS,
  UI_ACTIONS as ACTIONS_MJS,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — untyped daemon twin
} from '../../../../../mac-agent/ui-policy.mjs'

const CLAUDE = 'com.anthropic.claudefordesktop'
const CHATGPT = 'com.openai.chat'

/** Every case that matters, in one place, exercised against both copies. */
const CORPUS: Array<Record<string, unknown>> = [
  // green
  { action: 'ui_tree', bundleId: CLAUDE },
  { action: 'ui_screenshot', bundleId: CHATGPT },
  { action: 'ui_scroll', bundleId: CLAUDE },
  { action: 'ui_screenshot' },
  // amber
  { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Send' },
  { action: 'ui_click', bundleId: CHATGPT },
  { action: 'ui_type', bundleId: CHATGPT, text: 'orders page er bug ta dekho' },
  { action: 'ui_key', bundleId: CLAUDE, key: 'cmd+enter' },
  { action: 'ui_key', bundleId: CHATGPT, key: 'enter' },
  // red — apps
  { action: 'ui_tree', bundleId: 'com.apple.safari' },
  { action: 'ui_type', bundleId: 'com.apple.terminal', text: 'sudo rm -rf ~' },
  { action: 'ui_click', bundleId: 'com.googlecode.iterm2' },
  { action: 'ui_tree', bundleId: 'com.apple.keychainaccess' },
  { action: 'ui_click', bundleId: 'com.apple.systempreferences' },
  { action: 'ui_click', bundleId: 'com.apple.finder' },
  { action: 'ui_click', bundleId: 'com.apple.mail' },
  // red — labels
  { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Delete account' },
  { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Clear all history' },
  { action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Upgrade plan' },
  { action: 'ui_click', bundleId: CHATGPT, elementLabel: 'Buy credits' },
  { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Log out' },
  { action: 'ui_click', bundleId: CLAUDE, elementLabel: 'Always allow access' },
  // red — text and keys
  { action: 'ui_type', bundleId: CLAUDE, text: 'sk-abcdefghijklmnopqrstuvwxyz123456' },
  { action: 'ui_type', bundleId: CLAUDE, text: 'password: hunter2' },
  { action: 'ui_type', bundleId: CLAUDE, text: '-----BEGIN RSA PRIVATE KEY-----' },
  { action: 'ui_type', bundleId: CLAUDE, text: 'x'.repeat(5_000) },
  { action: 'ui_type', bundleId: CLAUDE, text: '  ' },
  { action: 'ui_key', bundleId: CLAUDE, key: 'cmd+q' },
  { action: 'ui_key', bundleId: CLAUDE, key: 'cmd+shift+delete' },
  { action: 'ui_key', bundleId: CLAUDE, key: '' },
  // red — malformed
  { action: 'ui_click' },
  { action: 'ui_drag', bundleId: CLAUDE },
  { action: '' },
  // case-insensitivity must agree on both sides
  { action: 'ui_click', bundleId: 'COM.OPENAI.CHAT', elementLabel: 'Send' },
]

describe('UI policy parity — server and daemon must agree exactly', () => {
  it('agrees on the allowlist itself', () => {
    expect(ALLOWED_MJS).toEqual(ALLOWED_TS)
  })

  it('agrees on the known action list', () => {
    expect([...ACTIONS_MJS]).toEqual([...ACTIONS_TS])
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
