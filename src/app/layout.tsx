import type { Metadata, Viewport } from 'next'
import { Hind_Siliguri, Inter, JetBrains_Mono, Noto_Sans_Bengali } from 'next/font/google'
import './globals.css'
import '@/components/providers/AppBootSplash.css'
import { cookies } from 'next/headers'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { AppProviders } from '@/components/providers/AppProviders'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { ACCENT_COOKIE, THEME_COOKIE, accentStyle, normalizeAccent, normalizeMode } from '@/lib/theme'
import { Toaster } from 'react-hot-toast'
import { GlobalPlatformChrome } from '@/components/layout/GlobalPlatformChrome'
import { AmbientBackground } from '@/components/ambient/AmbientBackground'
import { GlobalKeyboardManager } from '@/components/ui-mobile/GlobalKeyboardManager'
import { bootEscapeScript } from '@/lib/boot-escape-script'
import { buildMismatchReloadScript } from '@/lib/build-reload-script'

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
  themeColor: '#FAF9F6',
  width: 'device-width',
  initialScale: 1,
  /** Native Capacitor shell: lock zoom so touch never triggers pinch/zoom drift or jitter on iPhone. */
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  /** Lets the layout viewport shrink when the software keyboard opens (iOS 15+ / modern Safari). */
  interactiveWidget: 'resizes-content',
}

/** Cold Vercel + Prisma can exceed 3.5s; null session forces a full-screen client auth spinner. */
const SERVER_SESSION_TIMEOUT_MS = 7_000

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
  const buildReloadScript = buildMismatchReloadScript()
  const cookieStore = cookies()
  const themeMode = normalizeMode(cookieStore.get(THEME_COOKIE)?.value)
  const themeAccent = normalizeAccent(cookieStore.get(ACCENT_COOKIE)?.value)
  return (
    <html
      lang="en"
      data-theme={themeMode}
      style={accentStyle(themeAccent) as React.CSSProperties}
      className={`${inter.variable} ${notoBengali.variable} ${hindSiliguri.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {buildReloadScript && (
          <script dangerouslySetInnerHTML={{ __html: buildReloadScript }} />
        )}
        <script dangerouslySetInnerHTML={{ __html: bootEscapeScript() }} />
      </head>
      <body className="text-cream antialiased font-sans">
        <div id="alma-boot-splash" aria-hidden="true">
          <div className="alma-boot-mark">A</div>
          <p className="alma-boot-title">Alma ERP</p>
          <div className="alma-boot-spinner" />
        </div>
        <ThemeProvider initialMode={themeMode} initialAccent={themeAccent}>
          <AmbientBackground />
          <AppProviders session={session}>{children}</AppProviders>
        </ThemeProvider>
        {/* Drives --kb-inset / body.kb-open app-wide so ERP screens can pin
            focused inputs above the keyboard (Keyboard.resize is None). */}
        <GlobalKeyboardManager />
        <GlobalPlatformChrome />
        <Toaster
          position="top-right"
          toastOptions={{
            duration: 4000,
            style: {
              background: '#FFFFFF',
              color: '#1a1a2e',
              border: '1px solid #e5e2dc',
              fontFamily: 'var(--font-sans)',
              fontSize: '13px',
              boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
            },
            success: { iconTheme: { primary: '#81B29A', secondary: '#FFFFFF' } },
            error:   { iconTheme: { primary: '#E74C3C', secondary: '#FFFFFF' } },
          }}
        />
      </body>
    </html>
  )
}
