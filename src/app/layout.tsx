import type { Metadata, Viewport } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'
import './globals.css'
import { Sidebar, MobileNav } from '@/components/layout/Sidebar'
import { Toaster } from 'react-hot-toast'

const inter = Inter({ subsets: ['latin'], variable: '--font-sans' })
const mono  = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono' })

export const metadata: Metadata = {
  title: { default: 'Alma Lifestyle ERP', template: '%s · Alma ERP' },
  description: 'Luxury Fashion Brand ERP System — Google Sheets Connected',
  manifest: '/manifest.json',
  appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Alma ERP' },
}

export const viewport: Viewport = {
  themeColor: '#C9A84C',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body className="bg-black text-cream antialiased font-sans">
        <div className="flex h-[100dvh] w-full overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto min-w-0 scrollbar-hide">
            {children}
            {/* Spacer for mobile bottom nav */}
            <div className="h-16 md:hidden" />
          </main>
        </div>
        <MobileNav />
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
