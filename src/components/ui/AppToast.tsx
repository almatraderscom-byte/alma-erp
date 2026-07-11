'use client'

import { resolveValue, toast as hotToast, type Toast } from 'react-hot-toast'

/**
 * AppToast — the single, theme-matched renderer for every react-hot-toast in the app.
 *
 * Wired once in `layout.tsx` via `<Toaster>{(t) => <AppToast t={t} />}</Toaster>`, so
 * every existing `toast.success / .error / .loading` call (approvals, agent tasks, etc.)
 * gets this look with zero changes at the call sites.
 *
 * Goals (owner request): a beautiful success card that animates in, then auto-dismisses —
 * instead of plain white boxes stacking over the header.
 */

type ToastTone = 'success' | 'error' | 'loading' | 'blank'

const TONES: Record<ToastTone, { accent: string; ring: string; glow: string; halo: string }> = {
  success: {
    accent: '#81B29A',
    ring: 'rgba(129,178,154,0.45)',
    glow: 'rgba(129,178,154,0.20)',
    halo: 'rgba(129,178,154,0.16)',
  },
  error: {
    accent: '#E76A5A',
    ring: 'rgba(231,106,90,0.45)',
    glow: 'rgba(231,106,90,0.18)',
    halo: 'rgba(231,106,90,0.16)',
  },
  loading: {
    accent: '#E07A5F',
    ring: 'rgb(var(--c-accent)/0.40)',
    glow: 'rgb(var(--c-accent)/0.16)',
    halo: 'rgb(var(--c-accent)/0.14)',
  },
  blank: {
    accent: '#E07A5F',
    ring: 'rgb(var(--c-accent)/0.38)',
    glow: 'rgb(var(--c-accent)/0.14)',
    halo: 'rgb(var(--c-accent)/0.12)',
  },
}

function toneOf(t: Toast): ToastTone {
  if (t.type === 'success') return 'success'
  if (t.type === 'error') return 'error'
  if (t.type === 'loading') return 'loading'
  return 'blank'
}

function ToastIcon({ tone, accent }: { tone: ToastTone; accent: string }) {
  if (tone === 'loading') {
    return (
      <span
        aria-hidden
        className="h-6 w-6 shrink-0 rounded-full border-[2.5px] border-white/15"
        style={{ borderTopColor: accent, animation: 'alma-toast-spin 0.7s linear infinite' }}
      />
    )
  }

  return (
    <span
      aria-hidden
      className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full"
      style={{
        background: tone === 'success' ? 'rgba(129,178,154,0.16)' : 'rgba(231,106,90,0.16)',
        boxShadow: `inset 0 0 0 1.6px ${accent}`,
        animation: 'alma-toast-pop 360ms cubic-bezier(0.22,1,0.36,1)',
      }}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path
          d={tone === 'success' ? 'M5 12.5l4.2 4.2L19 7' : 'M7 7l10 10M17 7L7 17'}
          stroke={accent}
          strokeWidth="2.6"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            strokeDasharray: 32,
            strokeDashoffset: 32,
            animation: 'alma-toast-draw 460ms 110ms cubic-bezier(0.65,0,0.35,1) forwards',
          }}
        />
      </svg>
    </span>
  )
}

export function AppToast({ t }: { t: Toast }) {
  const tone = toneOf(t)
  const c = TONES[tone]
  const message = resolveValue(t.message, t)

  return (
    <div
      role="status"
      aria-live="polite"
      onClick={() => hotToast.dismiss(t.id)}
      className="alma-toast pointer-events-auto flex w-[min(90vw,360px)] cursor-pointer items-center gap-3 rounded-2xl font-sans"
      style={{
        // Surface (glass bg / border / shadow / accent bar) lives in .alma-toast
        // in globals.css so both themes flip via tokens; only the per-tone accent
        // and the entrance motion are set here.
        ['--toast-accent' as string]: c.accent,
        ['--toast-accent-soft' as string]: c.glow,
        opacity: t.visible ? 1 : 0,
        transform: t.visible ? 'translateY(0) scale(1)' : 'translateY(-16px) scale(0.94)',
        transition: 'opacity 260ms cubic-bezier(0.22,1,0.36,1), transform 380ms cubic-bezier(0.34,1.56,0.64,1)',
      }}
    >
      <ToastIcon tone={tone} accent={c.accent} />
      <div className="min-w-0 flex-1 text-[13px] font-semibold leading-snug" style={{ color: 'var(--toast-fg)' }}>
        {message}
      </div>
    </div>
  )
}
