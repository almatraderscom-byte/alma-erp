import type { Metadata } from 'next'
import { DownloadAppClient } from './DownloadAppClient'

export const metadata: Metadata = {
  title: 'Android App Download',
  robots: { index: false, follow: false },
}

export default function DownloadAppPage() {
  const apkUrl =
    process.env.NEXT_PUBLIC_ANDROID_APK_URL?.trim()
    || '/releases/alma-erp.apk'

  return <DownloadAppClient apkUrl={apkUrl} />
}
