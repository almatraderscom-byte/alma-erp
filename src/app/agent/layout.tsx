import type { ReactNode } from 'react'
import { AgentBottomNav } from '@/agent/components/AgentBottomNav'
import '@/agent/styles/agent-ambient.css'

export default function AgentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="agent-shell relative min-h-[100dvh] bg-[#FAF9F6] text-[#1a1a2e]">
      {/* Warm mesh gradient background */}
      <div
        className="pointer-events-none fixed inset-0 z-0"
        style={{
          background: `
            radial-gradient(ellipse 80% 50% at 20% 0%, rgba(224,122,95,0.08) 0%, transparent 50%),
            radial-gradient(ellipse 60% 60% at 80% 100%, rgba(129,178,154,0.06) 0%, transparent 50%),
            radial-gradient(ellipse 70% 40% at 50% 50%, rgba(212,168,75,0.04) 0%, transparent 50%),
            #FAF9F6
          `,
        }}
      />

      <main className="agent-main-height relative z-10">
        {children}
      </main>

      <AgentBottomNav />
    </div>
  )
}
