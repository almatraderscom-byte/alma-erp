import { Skeleton } from '@/components/ui'

/**
 * Layout-matched route skeleton — avoids spinner-only screens and layout shift.
 * WOW pass (owner-approved 2026-07): sections rise in with a soft stagger so a
 * route change feels like the page assembling itself, not a flat grey flash.
 * Motion is transform/opacity only (compositor-cheap) and reduced-motion aware.
 */
const MPS_CSS = `
@keyframes mps-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}
.mps-in{opacity:0;animation:mps-rise .5s cubic-bezier(.25,1.1,.4,1) forwards}
@media (prefers-reduced-motion: reduce){.mps-in{animation-duration:.01ms}}
`

export function ModulePageSkeleton({
  kpiCount = 4,
  tableRows = 5,
  showChart = false,
}: {
  kpiCount?: number
  tableRows?: number
  showChart?: boolean
}) {
  return (
    <div className="min-w-0 max-w-full space-y-4 px-3 py-4 pb-24 sm:px-6 md:pb-6">
      <style dangerouslySetInnerHTML={{ __html: MPS_CSS }} />
      <div className="mps-in space-y-2 border-b border-border pb-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-3.5 w-56 max-w-full" />
        <div className="flex flex-wrap gap-2 pt-1">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div
        className="mps-in grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9.75rem),1fr))]"
        style={{ animationDelay: '90ms' }}
      >
        {Array.from({ length: kpiCount }).map((_, i) => (
          <Skeleton key={i} className="h-[5.5rem] rounded-2xl" />
        ))}
      </div>
      {showChart && (
        <div className="mps-in" style={{ animationDelay: '180ms' }}>
          <Skeleton className="h-52 w-full rounded-2xl" />
        </div>
      )}
      <div className="mps-in hidden md:block" style={{ animationDelay: '240ms' }}>
        <Skeleton className="h-10 w-full max-w-md" />
      </div>
      <div
        className="mps-in hidden min-w-0 rounded-2xl border border-border bg-card md:block"
        style={{ animationDelay: '300ms' }}
      >
        <div className="border-b border-border px-4 py-3">
          <div className="flex gap-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-3 w-16" />
            ))}
          </div>
        </div>
        {Array.from({ length: tableRows }).map((_, i) => (
          <div key={i} className="flex gap-3 border-b border-border/50 px-4 py-3.5">
            {Array.from({ length: 6 }).map((__, j) => (
              <Skeleton key={j} className="h-3 flex-1" />
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-2 md:hidden">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="mps-in" style={{ animationDelay: `${180 + i * 90}ms` }}>
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        ))}
      </div>
    </div>
  )
}
