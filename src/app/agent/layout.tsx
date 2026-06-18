import type { ReactNode } from 'react'
import type { Viewport } from 'next'
import { AgentBottomNav } from '@/agent/components/AgentBottomNav'
import { AgentKeyboardManager } from '@/agent/components/AgentKeyboardManager'
import { AgentTodoProvider } from '@/agent/components/AgentTodoContext'
import '@/agent/styles/agent-ambient.css'

/**
 * Agent-only viewport: locks scale so iOS Safari doesn't auto-zoom on input focus.
 * Tradeoff: pinch-to-zoom disabled on /agent/* (acceptable for chat/dashboard UX).
 * ERP routes keep the root layout viewport (zoom remains available there).
 *
 * No `interactiveWidget: resizes-content` here on purpose: we drive the keyboard
 * inset ourselves via useKeyboardInset (--kb-inset), so letting the layout
 * viewport ALSO resize would double-count and push the composer off-screen.
 */
export const viewport: Viewport = {
  themeColor: '#FAF9F6',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
}

export default function AgentLayout({ children }: { children: ReactNode }) {
  return (
    <AgentTodoProvider>
      <AgentKeyboardManager />
      <div className="agent-shell relative min-h-[100dvh] text-cream">
        {/* Transparent shell: the root aurora (z-index:-1) glows through. */}

        <main className="agent-main-height relative z-10 flex flex-col">
          <div className="min-h-0 flex-1">
            {children}
          </div>
        </main>

        <AgentBottomNav />
      </div>
    </AgentTodoProvider>
  )
}
