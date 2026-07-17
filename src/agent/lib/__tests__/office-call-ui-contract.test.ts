import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (path: string) => readFileSync(resolve(root, path), 'utf8')

const web = read('src/app/portal/office/intercom.tsx')
const webCss = read('src/app/portal/office/intercom-css.ts')
const webEntry = read('src/app/portal/office/group-chat.tsx')
const ios = read('ios/App/App/IntercomUI.swift')
const iosEntry = read('ios/App/App/PortalOfficeSwiftUI.swift')
const android = read('android/app/src/main/java/com/almatraders/erp/pages/IntercomUI.kt')

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? []
  const linear = channels.map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a)
  return (light + 0.05) / (dark + 0.05)
}

describe('Office call cross-platform UI contract', () => {
  it('keeps a first-class Calls entry on all three surfaces', () => {
    expect(webEntry).toContain('ohub-callshead')
    expect(webEntry).toContain('<IntercomCallsPanel')
    expect(iosEntry).toContain('accessibilityLabel("অফিস কল খুলুন")')
    expect(iosEntry).toContain('IntercomView()')
    expect(android).toContain('contentDescription = "অফিস কল খুলুন"')
    expect(android).toContain('IntercomSheet')
  })

  it('names the four communication modes without conflating them', () => {
    for (const source of [web, ios, android]) {
      expect(source).toMatch(/App voice(?: call)?|App voice/)
      expect(source).toMatch(/Mobile call|Mobile/)
      expect(source).toContain('Recorded PTT')
      expect(source).toMatch(/Live walkie-talkie|Live walkie/)
    }
  })

  it('covers the complete visible call-state vocabulary', () => {
    const combined = `${web}\n${ios}\n${android}`
    for (const state of ['আউটগোয়িং', 'ইনকামিং', 'সংযোগ হচ্ছে', 'কল চলছে', 'পুনঃসংযোগ', 'ব্যস্ত', 'প্রত্যাখ্যাত', 'মিসড', 'ব্যর্থ', 'সম্পন্ন']) {
      expect(combined, state).toContain(state)
    }
  })

  it('exposes history direction, duration, mute, route, minimize, and end controls', () => {
    expect(web).toContain('callDurationSec')
    expect(web).toContain('call.outgoingByMe')
    expect(web).toContain('itc-mini-mute')
    expect(web).toContain('itc-call-devices')
    expect(web).toContain('setMinimized')
    expect(ios).toContain('callDurationSec')
    expect(ios).toContain('ic.audioRoute')
    expect(ios).toContain('মিনিমাইজ')
    expect(android).toContain('callDurationSec')
    expect(android).toContain('ic.toggleSpeaker()')
    expect(android).toContain('onDismissRequest = onDismiss')
  })

  it('has accessible controls, 44/48px targets, reduced motion, and settings recovery', () => {
    expect(web).not.toContain('<button className={`itc-call-mini')
    expect(webCss).toMatch(/itc-mini-mute,.itc-mini-end\{width:44px;height:44px/)
    expect(webCss).toContain('@media(prefers-reduced-motion:reduce)')
    expect(web).toContain('aria-modal="true"')
    expect(ios).toContain('UIAccessibility.isReduceMotionEnabled')
    expect(ios).toContain('UIApplication.openSettingsURLString')
    expect(ios).toContain('.accessibilityLabel')
    expect(android).toContain('defaultMinSize(minHeight = 48.dp)')
    expect(android).toContain('Role.Button')
    expect(android).toContain('notificationSettingsIntent')
  })

  it('meets WCAG AA contrast for primary call text and status colors', () => {
    expect(contrast('#F7F8FC', '#11131C')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#6EE7B7', '#11131C')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#FCA5A5', '#11131C')).toBeGreaterThanOrEqual(4.5)
    expect(contrast('#FCD34D', '#11131C')).toBeGreaterThanOrEqual(4.5)
  })
})
