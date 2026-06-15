'use client'

/**
 * AgentShell — now a pass-through wrapper.
 * The ambient background, film grain, and CSS are handled by the agent layout
 * (src/app/agent/layout.tsx). This component remains for backwards-compat but
 * simply renders children with proper height.
 */
export default function AgentShell({ children }: { children: React.ReactNode }) {
  return <div className="relative z-10 h-full">{children}</div>
}
