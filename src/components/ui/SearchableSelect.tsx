'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

export type SearchableSelectOption = {
  value: string
  label: string
  sublabel?: string
  searchText?: string
}

type SearchableSelectProps = {
  value: string
  onChange: (value: string) => void
  options: SearchableSelectOption[]
  placeholder?: string
  loading?: boolean
  disabled?: boolean
  emptyMessage?: string
  required?: boolean
  id?: string
  className?: string
}

export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Search…',
  loading = false,
  disabled = false,
  emptyMessage = 'No matches',
  required = false,
  id: idProp,
  className,
}: SearchableSelectProps) {
  const autoId = useId()
  const id = idProp ?? autoId
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selected = useMemo(
    () => options.find(o => o.value === value) ?? null,
    [options, value],
  )

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    return options.filter(o => {
      const hay = (o.searchText ?? `${o.label} ${o.sublabel ?? ''}`).toLowerCase()
      return hay.includes(q)
    })
  }, [options, query])

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [])

  return (
    <div ref={rootRef} className={cn('relative min-w-0', className)}>
      <button
        type="button"
        id={id}
        disabled={disabled || loading}
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen(v => !v)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-black/[0.03] px-3 py-2.5 text-left text-sm transition-colors',
          'focus:outline-none focus:border-gold-dim/60 focus:ring-1 focus:ring-gold-dim/30',
          disabled && 'opacity-50',
        )}
      >
        <span className="min-w-0 flex-1">
          {loading ? (
            <span className="text-zinc-500">Loading…</span>
          ) : selected ? (
            <>
              <span className="block truncate font-medium text-cream">{selected.label}</span>
              {selected.sublabel && (
                <span className="block truncate text-[10px] text-zinc-500">{selected.sublabel}</span>
              )}
            </>
          ) : (
            <span className="text-zinc-500">{placeholder}</span>
          )}
        </span>
        <span className="shrink-0 text-zinc-500" aria-hidden>
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open && !disabled && !loading && (
        <div
          role="listbox"
          className="absolute z-50 mt-1 max-h-56 w-full overflow-hidden rounded-xl border border-border bg-[#12141a] shadow-xl"
        >
          <div className="border-b border-border p-2">
            <input
              type="search"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Type to filter…"
              autoFocus
              required={required && !value}
              className="w-full rounded-lg border border-border bg-black/[0.03] px-3 py-2 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/50"
            />
          </div>
          <ul className="max-h-44 overflow-y-auto overscroll-contain py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-3 text-center text-xs text-zinc-500">{emptyMessage}</li>
            ) : (
              filtered.map(o => (
                <li key={o.value}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={o.value === value}
                    onClick={() => {
                      onChange(o.value)
                      setOpen(false)
                    }}
                    className={cn(
                      'w-full px-3 py-2.5 text-left transition-colors hover:bg-black/[0.04]',
                      o.value === value && 'bg-gold/10',
                    )}
                  >
                    <span className="block truncate text-sm font-medium text-cream">{o.label}</span>
                    {o.sublabel && (
                      <span className="block truncate text-[10px] text-zinc-500">{o.sublabel}</span>
                    )}
                  </button>
                </li>
              ))
            )}
          </ul>
        </div>
      )}
    </div>
  )
}
