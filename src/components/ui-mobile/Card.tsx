import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * The standard surface. Cream-on-white with the subtle card shadow; coral
 * accent border when `accent`. Uses brand tokens only — never raw colors.
 */
export function Card({
  children,
  className,
  accent,
  padding = 'md',
  as: Tag = 'div',
  ...props
}: {
  children: ReactNode
  className?: string
  /** Coral (brand) border for emphasis. */
  accent?: boolean
  padding?: 'none' | 'sm' | 'md' | 'lg'
  as?: 'div' | 'section' | 'article'
} & React.HTMLAttributes<HTMLDivElement>) {
  const pads = { none: '', sm: 'p-3', md: 'p-4', lg: 'p-5' }
  return (
    <Tag
      className={cn(
        'min-w-0 rounded-2xl border bg-card shadow-card',
        accent ? 'border-gold/30' : 'border-border-subtle',
        pads[padding],
        className,
      )}
      {...props}
    >
      {children}
    </Tag>
  )
}

export function CardHeader({ title, subtitle, action }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="truncate text-[15px] font-bold text-cream">{title}</h3>
        {subtitle != null && <p className="mt-0.5 truncate text-[12px] text-muted">{subtitle}</p>}
      </div>
      {action != null && <div className="shrink-0">{action}</div>}
    </div>
  )
}
