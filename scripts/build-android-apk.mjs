#!/usr/bin/env node
/**
 * Build Alma ERP Android APK (debug or release).
 * Usage:
 *   node scripts/build-android-apk.mjs debug
 *   node scripts/build-android-apk.mjs release
 *
 * Release signing (optional env):
 *   ALMA_ANDROID_KEYSTORE_PATH, ALMA_ANDROID_KEYSTORE_PASSWORD,
 *   ALMA_ANDROID_KEY_ALIAS, ALMA_ANDROID_KEY_PASSWORD
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const mode = (process.argv[2] || 'debug').toLowerCase()
const isRelease = mode === 'release'

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
  if (res.status !== 0) process.exit(res.status ?? 1)
}

// Disable Capacitor telemetry prompt (blocks non-interactive builds).
spawnSync('npx', ['cap', 'telemetry', 'off'], { cwd: ROOT, stdio: 'ignore' })

run('node', ['scripts/generate-mobile-icons.mjs'])
run('npx', ['cap', 'sync', 'android'], {
  env: { ...process.env, CI: 'true' },
})

const gradleTask = isRelease ? 'assembleRelease' : 'assembleDebug'
const androidDir = path.join(ROOT, 'android')
const isWin = process.platform === 'win32'
const gradlew = path.join(androidDir, isWin ? 'gradlew.bat' : 'gradlew')

run(gradlew, [gradleTask], { cwd: androidDir })

const googleServices = path.join(androidDir, 'app/google-services.json')
if (!existsSync(googleServices)) {
  console.error('\n❌ FATAL: android/app/google-services.json not found — push will NOT work.')
  console.error('   Download from Firebase Console → Project Settings → Android app')
  console.error('   Place at: android/app/google-services.json\n')
  process.exit(1)
}

// Resolve the actual gradle output. With a keystore configured, the release
// build is SIGNED and emitted as `app-release.apk`; without one it stays
// `app-release-unsigned.apk`. Try the signed name first so a signed build is
// picked up (the old hard-coded `-unsigned` name failed signed builds).
const apkCandidates = isRelease
  ? ['app-release.apk', 'app-release-unsigned.apk']
  : ['app-debug.apk']
const apkDir = path.join(androidDir, 'app/build/outputs/apk', isRelease ? 'release' : 'debug')
const built = apkCandidates.map((n) => path.join(apkDir, n)).find((p) => existsSync(p))
const outDir = path.join(ROOT, 'mobile/dist')
mkdirSync(outDir, { recursive: true })
const outName = isRelease ? 'alma-erp-release.apk' : 'alma-erp-debug.apk'
const outPath = path.join(outDir, outName)

if (!built) {
  console.error('APK not found in', apkDir, '— looked for:', apkCandidates.join(', '))
  process.exit(1)
}
if (isRelease && path.basename(built) === 'app-release-unsigned.apk') {
  console.warn(
    '\n⚠️  Built UNSIGNED release APK (no ALMA_ANDROID_KEYSTORE_PATH set) — ' +
      'it will NOT install on a normal device. Set the keystore env vars to sign.',
  )
}
copyFileSync(built, outPath)
const publicApk = path.join(ROOT, 'public/releases/alma-erp.apk')
mkdirSync(path.dirname(publicApk), { recursive: true })
copyFileSync(built, publicApk)
console.log('\n✅ APK ready:', outPath)
console.log('✅ Public download:', publicApk)
console.log('Live URL: https://alma-erp-six.vercel.app/releases/alma-erp.apk')
console.log('Staff page: https://alma-erp-six.vercel.app/download.html')
