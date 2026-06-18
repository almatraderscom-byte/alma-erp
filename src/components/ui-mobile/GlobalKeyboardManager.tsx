'use client'

import { useKeyboardInset } from './useKeyboardInset'

/**
 * Headless. Mounted once in the root layout so `--kb-inset` / `body.kb-open`
 * are driven app-wide (ERP + agent), not just on agent routes. This is what
 * lets ERP screens pin focused inputs above the keyboard.
 */
export function GlobalKeyboardManager() {
  useKeyboardInset()
  return null
}
