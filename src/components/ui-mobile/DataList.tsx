'use client'

import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export type DataListColumn<T> = {
  /** Stable id for the column. */
  key: string
  header: ReactNode
  /** Cell content for a given row. */
  render: (row: T) => ReactNode
  align?: 'left' | 'right' | 'center'
  /** Omit this column from the stacked mobile card (e.g. redundant with title). */
  hideOnMobile?: boolean
  /** Extra className for the desktop <td>/<th>. */
  cellClassName?: string
}

type Props<T> = {
  columns: Array<DataListColumn<T>>
  rows: T[]
  /** Unique key per row. */
  rowKey: (row: T) => string
  onRowClick?: (row: T) => void
  /** Heading shown on each mobile card (defaults to the first column's value). */
  renderCardTitle?: (row: T) => ReactNode
  empty?: ReactNode
  className?: string
}

const alignClass = (align?: 'left' | 'right' | 'center') =>
  align === 'right' ? 'text-right' : align === 'center' ? 'text-center' : 'text-left'

/**
 * The table → card responsive pattern. A real `<table>` from `md` up; on phones
 * each row becomes a stacked card with label/value pairs. This kills the
 * "desktop table squeezed onto a phone" pain in one place.
 */
export function DataList<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  renderCardTitle,
  empty,
  className,
}: Props<T>) {
  if (rows.length === 0) {
    return (
      <div className={cn('rounded-2xl border border-black/[0.06] bg-card p-8 text-center text-sm text-slate-400', className)}>
        {empty ?? 'No records.'}
      </div>
    )
  }

  const titleOf = renderCardTitle ?? ((row: T) => columns[0]?.render(row))
  const mobileColumns = columns.filter((c) => !c.hideOnMobile)
  const clickable = Boolean(onRowClick)

  return (
    <div className={className}>
      {/* ── Phone: stacked cards ── */}
      <div className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <div
            key={rowKey(row)}
            role={clickable ? 'button' : undefined}
            tabIndex={clickable ? 0 : undefined}
            onClick={clickable ? () => onRowClick!(row) : undefined}
            onKeyDown={
              clickable
                ? (e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onRowClick!(row)
                    }
                  }
                : undefined
            }
            className={cn(
              'min-w-0 rounded-2xl border border-black/[0.06] bg-card p-4 shadow-card',
              clickable && 'cursor-pointer transition-transform active:scale-[0.99]',
            )}
          >
            <div className="mb-2 text-[15px] font-bold text-cream">{titleOf(row)}</div>
            <dl className="flex flex-col gap-1.5">
              {mobileColumns.map((col) => (
                <div key={col.key} className="flex items-baseline justify-between gap-3">
                  <dt className="shrink-0 text-[12px] text-slate-500">{col.header}</dt>
                  <dd className={cn('min-w-0 text-[13px] font-medium text-cream', alignClass(col.align ?? 'right'))}>
                    {col.render(row)}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      {/* ── Wide: real table ── */}
      <div className="hidden md:block">
        <div className="table-scroll rounded-2xl border border-black/[0.06] bg-card">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-black/[0.06]">
                {columns.map((col) => (
                  <th
                    key={col.key}
                    className={cn(
                      'whitespace-nowrap px-4 py-3 text-[12px] font-semibold uppercase tracking-wide text-slate-500',
                      alignClass(col.align),
                      col.cellClassName,
                    )}
                  >
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={rowKey(row)}
                  onClick={clickable ? () => onRowClick!(row) : undefined}
                  className={cn(
                    'border-b border-black/[0.04] last:border-0',
                    clickable && 'cursor-pointer transition-colors hover:bg-bg-2',
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={cn('px-4 py-3 text-cream', alignClass(col.align), col.cellClassName)}
                    >
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
