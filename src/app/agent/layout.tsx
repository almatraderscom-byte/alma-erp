import type { ReactNode } from 'react'
import { AgentBottomNav } from '@/agent/components/AgentBottomNav'
import '@/agent/styles/agent-ambient.css'

export default function AgentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="agent-shell relative min-h-[100dvh] bg-[#08080A] text-white">
      {/* Film grain noise overlay */}
      <div
        className="pointer-events-none fixed inset-0 z-0 opacity-[0.015]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
          backgroundSize: '200px',
        }}
      />

      {/* Main content with bottom padding for nav on mobile */}
      <main className="relative z-10 h-[100dvh] pb-16 md:pb-0">
        {children}
      </main>

      {/* Bottom nav — mobile only */}
      <AgentBottomNav />
    </div>
  )
}
