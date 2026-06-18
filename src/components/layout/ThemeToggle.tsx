'use client'

import { cn } from '@/lib/utils'
import { useTheme } from '@/components/providers/ThemeProvider'
import { ACCENTS, type AccentKey } from '@/lib/theme'

/** Compact light/dark switch — for the desktop sidebar footer. */
export function ThemeToggle({ collapsed, className }: { collapsed?: boolean; className?: string }) {
  const { mode, toggleMode } = useTheme()
  const isDark = mode === 'dark'
  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} theme`}
      title={`Switch to ${isDark ? 'light' : 'dark'} theme`}
      className={cn(
        'flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl border border-border-subtle text-muted-hi transition-colors hover:bg-gold/[0.06] hover:text-cream',
        className,
      )}
    >
      <span className="text-sm leading-none">{isDark ? '☾' : '☀'}</span>
      {!collapsed && <span className="text-[11px] font-medium">{isDark ? 'Dark' : 'Light'}</span>}
    </button>
  )
}

const ACCENT_ORDER: AccentKey[] = ['coral', 'blue', 'green', 'violet', 'amber']

/** Full panel: light/dark segmented control + accent swatches — for the mobile drawer / settings. */
export function ThemePanel({ className }: { className?: string }) {
  const { mode, setMode, accent, setAccent } = useTheme()
  return (
    <div className={cn('rounded-2xl border border-border-subtle bg-card p-3', className)}>
      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.16em] text-muted">Appearance</p>

      <div className="grid grid-cols-2 gap-2">
        {(['light', 'dark'] as const).map(m => {
          const active = mode === m
          return (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={cn(
                'flex min-h-[44px] items-center justify-center gap-2 rounded-xl border text-[13px] font-bold capitalize transition-colors',
                active
                  ? 'border-gold/30 bg-gold/10 text-gold'
                  : 'border-border-subtle text-muted-hi hover:text-cream',
              )}
            >
              <span className="text-sm leading-none">{m === 'dark' ? '☾' : '☀'}</span>
              {m}
            </button>
          )
        })}
      </div>

      <p className="mb-2 mt-4 text-[10px] font-black uppercase tracking-[0.16em] text-muted">Accent</p>
      <div className="flex items-center gap-2.5">
        {ACCENT_ORDER.map(key => {
          const active = accent === key
          return (
            <button
              key={key}
              type="button"
              onClick={() => setAccent(key)}
              aria-label={`${ACCENTS[key].label} accent`}
              title={ACCENTS[key].label}
              className={cn(
                'h-8 w-8 rounded-full border-2 transition-transform active:scale-95',
                active ? 'border-cream/70 scale-110' : 'border-transparent',
              )}
              style={{ backgroundColor: `rgb(${ACCENTS[key].accent})` }}
            />
          )
        })}
      </div>
    </div>
  )
}
