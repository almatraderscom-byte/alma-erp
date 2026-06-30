import { Skeleton } from '@/components/ui'

export default function Loading() {
  return (
    <div className="mx-auto w-full max-w-3xl px-3 pb-24 pt-3 sm:px-4 sm:pb-10">
      <Skeleton className="mb-4 h-9 w-40" />
      <div className="mb-4 flex gap-1.5">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-7 w-20 rounded-full" />)}</div>
      <div className="space-y-2">{Array.from({ length: 7 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
    </div>
  )
}
