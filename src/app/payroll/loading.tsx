function Bar({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-800/80 ${className}`} />
}

export default function PayrollLoading() {
  return (
    <div className="min-w-0 max-w-full space-y-5 p-4 sm:p-6">
      <div className="space-y-2">
        <Bar className="h-8 w-40" />
        <Bar className="h-4 w-64 max-w-full" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {Array.from({ length: 6 }).map((_, i) => (
          <Bar key={i} className="h-20 w-full rounded-2xl" />
        ))}
      </div>
      <Bar className="h-36 w-full rounded-2xl" />
      <div className="rounded-2xl border border-border bg-card p-4">
        <Bar className="mb-4 h-5 w-48" />
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="grid grid-cols-6 gap-2">
              {Array.from({ length: 6 }).map((__, j) => (
                <Bar key={j} className="h-8 w-full" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
