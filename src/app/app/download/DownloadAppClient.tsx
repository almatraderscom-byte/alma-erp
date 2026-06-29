'use client'

import { Button, Card } from '@/components/ui'
import { isCapacitorNative } from '@/lib/app-update'

/** Inside the Capacitor WebView a plain `<a download>` does nothing — the
 *  Android WebView has no DownloadListener, so the APK response is silently
 *  dropped. Hand the URL to the SYSTEM browser via window.open('_blank') so
 *  Chrome's download manager fetches the APK. CRITICAL: the URL must be on a
 *  host that is NOT in Capacitor `allowNavigation` (alma-erp-six.vercel.app),
 *  otherwise window.open keeps it inside the WebView and nothing downloads. We
 *  serve an off-domain copy from Supabase public storage for exactly this. On
 *  web/desktop the normal same-origin anchor download is kept. */
const NATIVE_APK_URL =
  'https://nrkuzcorcpcwrkckbeoq.supabase.co/storage/v1/object/public/app-releases/alma-erp.apk'

const SAMSUNG_PUSH_STEPS = [
  'Settings → Apps → Alma ERP → Battery → Unrestricted',
  'Settings → Battery → Background usage limits → Never sleeping apps → Alma ERP যোগ করুন',
  'Settings → Apps → Google Play services → Battery → Unrestricted',
  'Settings → Battery → Battery optimization → Google Play services → Don\'t optimize',
]

const STEPS = [
  'নিচের বাটনে ক্লিক করে APK ডাউনলোড করুন',
  'ডাউনলোড শেষে ফাইলে ট্যাপ করুন — Install',
  'প্রথমবার “Unknown sources” allow করতে বললে Settings থেকে অনুমতি দিন',
  'ইনস্টল হয়ে গেলে Home screen-এ Alma ERP icon খুলুন',
  'লগইন করুন — সব data আগের মতোই server থেকে আসবে',
]

type Props = { apkUrl: string }

export function DownloadAppClient({ apkUrl }: Props) {
  return (
    <main className="min-h-[100dvh] bg-black px-4 py-10 text-cream">
      <div className="mx-auto max-w-lg space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl border border-gold-dim/45 bg-gold/10 text-lg font-black text-gold-lt">
            A
          </div>
          <p className="text-[11px] font-black tracking-[0.2em] text-gold">ALMA ERP</p>
          <h1 className="mt-2 text-xl font-bold">Android App ডাউনলোড</h1>
          <p className="mt-2 text-sm text-muted">
            Play Store ছাড়া — শুধু Alma staff-দের জন্য। ERP server একই, কোনো data change নেই।
          </p>
        </div>

        <Card className="space-y-4 p-5">
          <a
            href={apkUrl}
            download
            className="block"
            onClick={(e) => {
              // Native app: WebView can't download — open APK in system browser.
              if (isCapacitorNative()) {
                e.preventDefault()
                // Off-domain URL → Capacitor punts window.open('_blank') to the
                // system browser (ACTION_VIEW intent), whose download manager
                // fetches the APK. A same-domain URL would stay in the WebView
                // and silently fail.
                window.open(NATIVE_APK_URL, '_blank', 'noopener,noreferrer')
              }
            }}
          >
            <Button variant="gold" className="w-full">
              Alma ERP APK ডাউনলোড করুন
            </Button>
          </a>
          <p className="text-center text-[11px] text-muted break-all">{apkUrl}</p>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-gold-lt">ইনস্টল করার নিয়ম</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-gold-lt">Samsung ফোন (S24/S25 ইত্যাদি)</h2>
          <p className="mt-2 text-xs text-muted">
            Push notification পেতে নিচের সেটিংস অবশ্যই করুন — One UI battery optimization push বন্ধ করে দেয়।
          </p>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-muted">
            {SAMSUNG_PUSH_STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Card>

        <p className="text-center text-xs text-muted">
          সমস্যা হলে browser/PWA uninstall করে শুধু এই app ব্যবহার করুন।
        </p>
      </div>
    </main>
  )
}
