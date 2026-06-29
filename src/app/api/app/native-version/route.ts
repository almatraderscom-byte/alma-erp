import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * Owner-tunable forced-update gate for the native Android app.
 *
 * `minBuild` is the minimum Android versionCode allowed to run. Any installed
 * app below it is hard-blocked by <ForcedUpdateGate> until the user installs a
 * newer APK. The value lives in `agent_kv_settings` so the owner can raise it
 * WITHOUT a redeploy whenever a new APK ships (just bump the row). When the key
 * is absent or unparseable we return 0, which disables the gate entirely —
 * fail-safe so a bad/missing value can never brick the app.
 *
 * `apkUrl` MUST stay on an off-domain host (Supabase public storage) that is NOT
 * in Capacitor `allowNavigation` (capacitor.config.ts → alma-erp-six.vercel.app),
 * otherwise window.open keeps it inside the WebView and the download fails.
 */
const KV_KEY = 'min_native_android_build'
const APK_URL =
  'https://nrkuzcorcpcwrkckbeoq.supabase.co/storage/v1/object/public/app-releases/alma-erp.apk'

export async function GET() {
  let minBuild = 0
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const row = await (prisma as any).agentKvSetting.findUnique({ where: { key: KV_KEY } })
    const parsed = parseInt(String(row?.value ?? ''), 10)
    if (Number.isFinite(parsed) && parsed > 0) minBuild = parsed
  } catch {
    minBuild = 0
  }

  return NextResponse.json(
    { minBuild, apkUrl: APK_URL },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  )
}
