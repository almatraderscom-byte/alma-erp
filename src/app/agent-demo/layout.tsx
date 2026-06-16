import type { ReactNode } from 'react'
import type { Metadata, Viewport } from 'next'

export const metadata: Metadata = {
  title: 'ALMA Agent — Design Demo',
  description: 'A live design preview of the ALMA Agent experience (mock data).',
}

export const viewport: Viewport = {
  themeColor: '#FAF9F6',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default function AgentDemoLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-[100dvh] bg-[#FAF9F6] text-[#1a1a2e]">
      {/* Warm mesh gradient background */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 20% 0%, rgba(224,122,95,0.10) 0%, transparent 50%),
            radial-gradient(ellipse 60% 60% at 80% 100%, rgba(129,178,154,0.07) 0%, transparent 50%),
            radial-gradient(ellipse 70% 40% at 50% 50%, rgba(212,168,75,0.05) 0%, transparent 50%),
            #FAF9F6
          `,
        }}
      />
      <div className="relative z-10 min-h-[100dvh]">{children}</div>
    </div>
  )
}
