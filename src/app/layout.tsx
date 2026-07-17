import type { Metadata, Viewport } from 'next'
import { Hind_Siliguri, Inter, JetBrains_Mono, Noto_Sans_Bengali } from 'next/font/google'
import './globals.css'
import '@/styles/ios27.css'
import '@/components/providers/AppBootSplash.css'
import { cookies } from 'next/headers'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { AppProviders } from '@/components/providers/AppProviders'
import { ThemeProvider } from '@/components/providers/ThemeProvider'
import { ACCENT_COOKIE, THEME_COOKIE, accentStyle, normalizeAccent, normalizeMode } from '@/lib/theme'
import { AppToaster } from '@/components/ui/AppToaster'
import { ConfirmDialogHost } from '@/components/ui/confirm-dialog'
import { PromptDialogHost } from '@/components/ui/prompt-dialog'
import { GlobalPlatformChrome } from '@/components/layout/GlobalPlatformChrome'
import { ConnectionGuard } from '@/components/providers/ConnectionGuard'
import TopScrollFade from '@/components/layout/TopScrollFade'
import { AmbientBackground } from '@/components/ambient/AmbientBackground'
import { GlobalKeyboardManager } from '@/components/ui-mobile/GlobalKeyboardManager'
import { bootEscapeScript } from '@/lib/boot-escape-script'
import { buildMismatchReloadScript } from '@/lib/build-reload-script'
import { Analytics } from '@vercel/analytics/next'

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
  // theme-color is set dynamically in <head> from the SSR theme cookie (below) so
  // the browser/PWA chrome + Android status bar match light vs dark, not a fixed dark.
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
        <meta name="theme-color" content={themeMode === 'light' ? '#f6f4ef' : '#0c0b12'} />
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
          <div className="alma-boot-orb">
            <span className="alma-boot-halo" />
            <span className="alma-boot-ring1" />
            <span className="alma-boot-ring2" />
            <span className="alma-boot-core">A</span>
          </div>
          <p className="alma-boot-word">
            <span>A</span>
            <span>L</span>
            <span>M</span>
            <span>A</span>
          </p>
          <div className="alma-boot-line"><i /></div>
        </div>
        <ThemeProvider initialMode={themeMode} initialAccent={themeAccent}>
          <AmbientBackground />
          <AppProviders session={session}>{children}</AppProviders>
        </ThemeProvider>
        {/* Drives --kb-inset / body.kb-open app-wide so ERP screens can pin
            focused inputs above the keyboard (Keyboard.resize is None). */}
        <GlobalKeyboardManager />
        <GlobalPlatformChrome />
        {/* App-wide top scroll-edge progressive blur (native shell only — gated on
            html.alma-native inside the component's CSS; desktop/web unaffected).
            The SwiftUI twin is ios/App/App/ClaudeTopFade.swift — tokens must match. */}
        <TopScrollFade />
        <AppToaster />
        <ConfirmDialogHost />
        <PromptDialogHost />
        {/* App-wide offline takeover + reconnect flood (owner-approved WOW design). */}
        <ConnectionGuard />
        <Analytics />
      </body>
    </html>
  )
}
