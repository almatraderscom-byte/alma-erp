#!/usr/bin/env node
/**
 * Smoke test: Alma custom notification sound assets + wiring.
 * Usage: node scripts/smoke-notification-sound.mjs
 */
import { readFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const checks = []

function ok(name, pass, detail = '') {
  checks.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

function readText(rel) {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

const webMp3 = 'public/sounds/alma-notification.mp3'
const androidMp3 = 'android/app/src/main/res/raw/alma_alert.mp3'

for (const file of [webMp3, androidMp3]) {
  const full = path.join(ROOT, file)
  ok(`${file} exists`, existsSync(full))
  if (existsSync(full)) {
    const size = statSync(full).size
    ok(`${file} size`, size > 10_000, `${size} bytes`)
    const buf = readFileSync(full)
    const isMp3 = buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33 // ID3
      || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
    ok(`${file} mp3 magic`, isMp3)
  }
}

const sw = readText('public/sw.js')
ok('sw.js caches sound', sw.includes("'/sounds/alma-notification.mp3'"))
ok('sw.js push relay', sw.includes('ALMA_PLAY_NOTIFICATION_SOUND'))
ok('sw.js v10', sw.includes("SW_VERSION = 'v10'"))

const java = readText('android/app/src/main/java/com/almatraders/erp/AlmaPushChannels.java')
ok('Android channel uses alma_alert', java.includes('"alma_alert", "raw"'))

const notifications = readText('src/lib/notifications.ts')
ok('notifications data soundUrl', notifications.includes('soundUrl: notificationSoundUrl()'))
ok('notifications alma_alerts channel', notifications.includes("existing_android_channel_id: 'alma_alerts'"))

const soundLib = readText('src/lib/notification-sound.ts')
ok('notification-sound path', soundLib.includes("'/sounds/alma-notification.mp3'"))

const providers = readText('src/components/providers/AppProviders.tsx')
ok('NotificationSoundBridge wired', providers.includes('NotificationSoundBridge'))

const oneSignal = readText('src/components/notifications/OneSignalPushManager.tsx')
ok('OneSignal plays custom sound', oneSignal.includes('playAlmaNotificationSound'))

ok('middleware allows sounds', readText('src/middleware.ts').includes('sounds/'))

const failed = checks.filter(c => !c.pass)
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} checks passed`)
