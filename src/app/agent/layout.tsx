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
 * `minimumScale: 1` is the real fix for the "whole screen zooms out / shifts" bug
 * on the delegation card (and any wide block). initialScale/maximumScale only set
 * the start and cap zoom-IN; they do NOT stop WKWebView shrink-to-fit, which scales
 * the WHOLE page DOWN (to minimum-scale, default 0.25) when any element's measured
 * width exceeds device-width — even one hidden by overflow:hidden, since shrink-to-fit
 * measures pre-clip content width. Floor == ceiling == 1 pins scale at 1.0, so the
 * page can never zoom out; a stray-wide child just clips (handled in CSS) instead.
 *
 * No `interactiveWidget: resizes-content` here on purpose: we drive the keyboard
 * inset ourselves via useKeyboardInset (--kb-inset), so letting the layout
 * viewport ALSO resize would double-count and push the composer off-screen.
 */
export const viewport: Viewport = {
  themeColor: '#FAF9F6',
  width: 'device-width',
  initialScale: 1,
  minimumScale: 1,
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
