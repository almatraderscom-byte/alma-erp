'use client'

import '../styles/agent-ambient.css'

export default function AgentShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="agent-shell relative min-h-screen overflow-hidden">
      {/* Film grain noise overlay */}
      <div
        className="pointer-events-none absolute inset-0 z-0 opacity-[0.015]"
        style={{
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='1'/%3E%3C/svg%3E")`,
          backgroundSize: '200px',
        }}
      />
      <div className="relative z-10 h-full">{children}</div>
    </div>
  )
}
