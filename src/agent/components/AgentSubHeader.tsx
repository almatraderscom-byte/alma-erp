'use client'

import type { ReactNode } from 'react'
import { PageBackButton } from '@/components/layout/PageBackButton'
import { cn } from '@/lib/utils'

/**
 * AgentSubHeader — one premium, consistent app-bar for every /agent/* sub-page.
 *
 * The agent section used to let each screen invent its own header (or none), so
 * it felt disorganized vs the rest of the ERP: some pages had no back button and
 * trapped the user, some rendered the title under the iPhone notch, some let the
 * title scroll away. This is the single shared top-bar — like the ERP PageHeader
 * but tuned for the agent's frosted dark theme:
 *
 *   - sticky to the top of its scroll container (stays put while content scrolls)
 *   - safe-area top padding so the title never sits under the notch / island
 *   - a back chevron (PageBackButton) that goes back in history and, on a deep
 *     link with no history, falls back to /agent (the chat home) — so no page is
 *     ever a dead end
 *   - title (+ optional coral accent word) + subtitle + an optional actions slot
 *
 * For `sticky top-0` to actually stick, mount this as the FIRST child INSIDE the
 * page's scrolling element.
 */
export function AgentSubHeader({
  title,
  accent,
  subtitle,
  actions,
  className,
}: {
  title: ReactNode
  /** Optional trailing word rendered in the coral accent (e.g. "ড্যাশবোর্ড"). */
  accent?: string
  subtitle?: ReactNode
  actions?: ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        'agent-subheader sticky top-0 z-30 border-b border-border-subtle bg-card/80 px-4 backdrop-blur-xl md:px-6',
        className,
      )}
      // Clear the status bar / Dynamic Island so the title + back never hide under it.
      style={{ paddingTop: 'max(0.6rem, env(safe-area-inset-top))', paddingBottom: '0.6rem' }}
    >
      <div className="mx-auto flex max-w-5xl items-center gap-3">
        <PageBackButton force fallbackHref="/agent" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-bold tracking-tight text-cream md:text-lg">
            {title}
            {accent ? <> <span className="text-[#E07A5F]">{accent}</span></> : null}
          </h1>
          {subtitle != null && subtitle !== '' && (
            <p className="mt-0.5 truncate text-[11px] text-muted">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
