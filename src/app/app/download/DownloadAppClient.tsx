'use client'

import { Button, Card } from '@/components/ui'

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
          <p className="mt-2 text-sm text-zinc-400">
            Play Store ছাড়া — শুধু Alma staff-দের জন্য। ERP server একই, কোনো data change নেই।
          </p>
        </div>

        <Card className="space-y-4 p-5">
          <a href={apkUrl} download className="block">
            <Button variant="gold" className="w-full">
              Alma ERP APK ডাউনলোড করুন
            </Button>
          </a>
          <p className="text-center text-[11px] text-zinc-500 break-all">{apkUrl}</p>
        </Card>

        <Card className="p-5">
          <h2 className="text-sm font-semibold text-gold-lt">ইনস্টল করার নিয়ম</h2>
          <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-300">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Card>

        <p className="text-center text-xs text-zinc-500">
          সমস্যা হলে browser/PWA uninstall করে শুধু এই app ব্যবহার করুন।
        </p>
      </div>
    </main>
  )
}
