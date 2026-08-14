/**
 * Regression: the app-wide haptic keydown bridge crashed on events whose `key`
 * is not a string. Password managers, IME composition and mobile autofill all
 * dispatch those, which is why /login produced most of the month's client
 * crashes ("Cannot read properties of undefined (reading 'length')").
 */
import { describe, expect, it } from 'vitest'
import { isEditableKey } from '@/components/providers/HapticBridge'

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>

function ev(key: unknown, mods: Partial<KeyLike> = {}): KeyLike {
  return { key: key as string, metaKey: false, ctrlKey: false, altKey: false, ...mods }
}

describe('isEditableKey', () => {
  it('does not throw when key is undefined (autofill / IME event)', () => {
    expect(() => isEditableKey(ev(undefined))).not.toThrow()
    expect(isEditableKey(ev(undefined))).toBe(false)
  })

  it('ignores a non-string key of any shape', () => {
    expect(isEditableKey(ev(null))).toBe(false)
    expect(isEditableKey(ev(229))).toBe(false)
  })

  it('still fires for printable characters and the editing keys', () => {
    expect(isEditableKey(ev('a'))).toBe(true)
    expect(isEditableKey(ev('অ'))).toBe(true)
    expect(isEditableKey(ev('Backspace'))).toBe(true)
    expect(isEditableKey(ev('Enter'))).toBe(true)
  })

  it('stays quiet for shortcuts and named navigation keys', () => {
    expect(isEditableKey(ev('a', { metaKey: true }))).toBe(false)
    expect(isEditableKey(ev('ArrowDown'))).toBe(false)
  })
})
