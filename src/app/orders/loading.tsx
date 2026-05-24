function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-800/80 ${className}`} />
}

export default function OrdersLoading() {
  return (
    <div className="min-w-0 max-w-full space-y-4 px-3 py-4 pb-24 sm:px-6 md:pb-6">
      <div className="space-y-2">
        <Bar className="h-8 w-48" />
        <Bar className="h-4 w-72 max-w-full" />
      </div>
      <Bar className="h-10 w-full max-w-md" />
      <div className="flex gap-2 overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <Bar key={i} className="h-8 w-24 shrink-0 rounded-full" />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <Bar className="h-10 min-w-48 flex-1" />
        <Bar className="h-10 w-32" />
        <Bar className="h-10 w-32" />
        <Bar className="h-10 w-28" />
      </div>
      <Bar className="h-12 w-full rounded-xl" />
      <div className="hidden min-w-0 rounded-2xl border border-border bg-card p-0 md:block">
        <div className="border-b border-border px-3 py-3">
          <div className="flex gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <Bar key={i} className="h-3 w-16" />
            ))}
          </div>
        </div>
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3 border-b border-border/50 px-3 py-3.5">
            {Array.from({ length: 10 }).map((__, j) => (
              <Bar key={j} className="h-3 flex-1" />
            ))}
          </div>
        ))}
      </div>
      <div className="space-y-2 md:hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Bar key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    </div>
  )
}
