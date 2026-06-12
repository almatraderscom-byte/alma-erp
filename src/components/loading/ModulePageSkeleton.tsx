import { Skeleton } from '@/components/ui'

/** Layout-matched route skeleton — avoids spinner-only screens and layout shift. */
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
      <div className="space-y-2 border-b border-border pb-4">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-3.5 w-56 max-w-full" />
        <div className="flex flex-wrap gap-2 pt-1">
          <Skeleton className="h-9 w-32" />
          <Skeleton className="h-9 w-28" />
        </div>
      </div>
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(100%,9.75rem),1fr))]">
        {Array.from({ length: kpiCount }).map((_, i) => (
          <Skeleton key={i} className="h-[5.5rem] rounded-2xl" />
        ))}
      </div>
      {showChart && <Skeleton className="h-52 w-full rounded-2xl" />}
      <Skeleton className="hidden h-10 w-full max-w-md md:block" />
      <div className="hidden min-w-0 rounded-2xl border border-border bg-card md:block">
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
          <Skeleton key={i} className="h-24 w-full rounded-2xl" />
        ))}
      </div>
    </div>
  )
}
