import type { Metadata, Viewport } from 'next'
import { Hind_Siliguri, Inter, JetBrains_Mono, Noto_Sans_Bengali } from 'next/font/google'
import './globals.css'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { AppProviders } from '@/components/providers/AppProviders'
import { Toaster } from 'react-hot-toast'
import { GlobalPlatformChrome } from '@/components/layout/GlobalPlatformChrome'
import { APP_BUILD_ID, RUNTIME_BUILD_STORAGE_KEY } from '@/lib/runtime-build'

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' })
const notoBengali = Noto_Sans_Bengali({
  subsets: ['bengali', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-bengali',
  display: 'swap',
})
const hindSiliguri = Hind_Siliguri({
  subsets: ['bengali', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-hind',
  display: 'swap',
})
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: { default: 'Alma ERP', template: '%s · Alma ERP' },
  description: 'Multi-business ERP — Alma Lifestyle & Creative Digital IT',
  manifest: '/manifest.json',
  icons: {
    icon: '/icon.svg',
    apple: '/icon.svg',
  },
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Alma ERP' },
}

export const viewport: Viewport = {
  themeColor: '#C9A84C',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  /** Lets the layout viewport shrink when the software keyboard opens (iOS 15+ / modern Safari). */
  interactiveWidget: 'resizes-content',
}

const SERVER_SESSION_TIMEOUT_MS = 2_500

async function loadServerSession() {
  try {
    return await Promise.race([
      getServerSession(authOptions),
      new Promise<null>(resolve => {
        setTimeout(() => resolve(null), SERVER_SESSION_TIMEOUT_MS)
      }),
    ])
  } catch {
    return null
  }
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await loadServerSession()
  return (
    <html lang="en" className={`${inter.variable} ${notoBengali.variable} ${hindSiliguri.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {APP_BUILD_ID !== 'dev' && APP_BUILD_ID !== 'local' && (
          <script
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var k=${JSON.stringify(RUNTIME_BUILD_STORAGE_KEY)};var b=${JSON.stringify(APP_BUILD_ID)};var s=localStorage.getItem(k);if(s&&s!==b){localStorage.setItem(k,b);if('serviceWorker' in navigator){navigator.serviceWorker.getRegistrations().then(function(r){return Promise.all(r.map(function(x){return x.unregister()}))}).then(function(){if('caches' in window)return caches.keys().then(function(keys){return Promise.all(keys.map(function(n){return caches.delete(n)}))})}).finally(function(){location.reload()})}}else if(!s){localStorage.setItem(k,b)}}catch(e){}})();`,
            }}
          />
        )}
      </head>
      <body className="bg-black text-cream antialiased font-sans">
        <AppProviders session={session}>{children}</AppProviders>
        <GlobalPlatformChrome />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#141418',
              color: '#E8E8E2',
              border: '1px solid #2A2A34',
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
            },
            success: { iconTheme: { primary: '#C9A84C', secondary: '#08080A' } },
            error:   { iconTheme: { primary: '#E74C3C', secondary: '#08080A' } },
          }}
        />
      </body>
    </html>
  )
}
