import type { Metadata, Viewport } from 'next'
import { Hind_Siliguri, Inter, JetBrains_Mono, Noto_Sans_Bengali } from 'next/font/google'
import './globals.css'
import { AppShell } from '@/components/layout/AppShell'
import { Toaster } from 'react-hot-toast'

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
    <html lang="en" className={`${inter.variable} ${notoBengali.variable} ${hindSiliguri.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
      </head>
      <body className="bg-black text-cream antialiased font-sans">
        <AppShell>{children}</AppShell>
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
