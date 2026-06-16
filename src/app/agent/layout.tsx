import type { ReactNode } from 'react'
import type { Viewport } from 'next'
import { AgentBottomNav } from '@/agent/components/AgentBottomNav'
import { AgentTodoProvider } from '@/agent/components/AgentTodoContext'
import { AgentTodoBar } from '@/agent/components/AgentTodoBar'
import '@/agent/styles/agent-ambient.css'

/**
 * Agent-only viewport: locks scale so iOS Safari doesn't auto-zoom on input focus.
 * Tradeoff: pinch-to-zoom disabled on /agent/* (acceptable for chat/dashboard UX).
 * ERP routes keep the root layout viewport (zoom remains available there).
 */
export const viewport: Viewport = {
  themeColor: '#FAF9F6',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

export default function AgentLayout({ children }: { children: ReactNode }) {
  return (
    <AgentTodoProvider>
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

        <main className="agent-main-height relative z-10 flex flex-col">
          <AgentTodoBar />
          <div className="min-h-0 flex-1">
            {children}
          </div>
        </main>

        <AgentBottomNav />
      </div>
    </AgentTodoProvider>
  )
}
