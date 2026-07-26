'use client'

import type { ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { toast } from 'react-hot-toast'
import { cn } from '@/lib/utils'
import { saveImageToDevice } from '@/lib/capacitor-native'

export type StudioStatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const STATUS_TONE_CLASS: Record<StudioStatusTone, string> = {
  neutral: 'bg-black/60 text-white',
  success: 'bg-emerald-500/90 text-white',
  warning: 'bg-amber-500/90 text-black',
  danger: 'bg-red-500/90 text-white',
  info: 'bg-[#E07A5F]/90 text-white',
}

export const STUDIO_STATUS_LABELS_BN = {
  ready: { label: 'Ready', tone: 'success' },
  qc_failed: { label: 'QC ফেল', tone: 'warning' },
  processing: { label: 'তৈরি হচ্ছে', tone: 'info' },
  failed: { label: 'ব্যর্থ', tone: 'danger' },
  draft: { label: 'Draft', tone: 'neutral' },
} as const satisfies Record<string, { label: string; tone: StudioStatusTone }>

export function getStudioStatusMeta(state: string): {
  label: string
  tone: StudioStatusTone
} {
  return STUDIO_STATUS_LABELS_BN[state as keyof typeof STUDIO_STATUS_LABELS_BN] ?? STUDIO_STATUS_LABELS_BN.draft
}

export function StudioStatusBadge({ label, tone = 'neutral', className }: { label: string; tone?: StudioStatusTone; className?: string }) {
  return <span className={cn('rounded px-1.5 py-0.5 text-[11px] font-bold', STATUS_TONE_CLASS[tone], className)}>{label}</span>
}

export function StudioLoadingState({ label = 'লোড হচ্ছে…', cards = 6 }: { label?: string; cards?: number }) {
  return (
    <div role="status" aria-label={label} className="space-y-2">
      <span className="sr-only">{label}</span>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
        {Array.from({ length: cards }).map((_, index) => (
          <div key={index} className="aspect-[4/5] animate-pulse rounded-xl bg-white/[0.05]" />
        ))}
      </div>
    </div>
  )
}

export function StudioEmptyState({ title = 'এখানে এখনো কোনো Creative নেই।', detail }: { title?: string; detail?: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border-subtle bg-card/40 px-4 py-8 text-center">
      <p className="text-sm font-semibold text-cream">{title}</p>
      {detail && <p className="mt-1 text-[11px] text-muted">{detail}</p>}
    </div>
  )
}

export function StudioErrorState({
  message,
  onRetry,
  retryLabel = 'আবার চেষ্টা',
}: {
  message: string
  onRetry?: () => void
  retryLabel?: string
}) {
  return (
    <div
      role="alert"
      className="flex items-center justify-between gap-3 rounded-xl border border-red-400/20 bg-red-500/[0.08] px-3 py-2 text-[11px] text-red-300"
    >
      <span>{message}</span>
      {onRetry && (
        <button type="button" onClick={onRetry} className="shrink-0 font-bold text-white">
          {retryLabel}
        </button>
      )}
    </div>
  )
}

export function StudioConfirmationDialog({
  open,
  ariaLabel,
  title,
  summary,
  children,
  cancelLabel = 'বাতিল',
  confirmLabel = 'নিশ্চিত করুন',
  onCancel,
  onConfirm,
  confirmDisabled = false,
}: {
  open: boolean
  ariaLabel: string
  title: string
  summary?: string
  children?: ReactNode
  cancelLabel?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => void
  confirmDisabled?: boolean
}) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          role="dialog"
          aria-modal="true"
          aria-label={ariaLabel}
          onClick={onCancel}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
        >
          <motion.div
            initial={{ y: 16, scale: 0.98 }}
            animate={{ y: 0, scale: 1 }}
            exit={{ y: 12, scale: 0.98, opacity: 0 }}
            onClick={(event) => event.stopPropagation()}
            className="w-[min(92vw,420px)] rounded-2xl border border-white/15 bg-[#17181d] p-4 shadow-2xl"
          >
            <p className="text-sm font-bold text-cream">{title}</p>
            {summary && <p className="mt-1 text-[11px] text-muted">{summary}</p>}
            {children}
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={onCancel} className="flex-1 rounded-xl bg-white/10 py-2.5 text-[12px] font-bold text-cream">
                {cancelLabel}
              </button>
              <button
                type="button"
                disabled={confirmDisabled}
                onClick={onConfirm}
                className="flex-1 rounded-xl bg-[#E07A5F] py-2.5 text-[12px] font-bold text-white disabled:opacity-40"
              >
                {confirmLabel}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

/** Native-safe download for both the web app and the iOS web shell. */
export async function downloadStudioAsset(url: string | undefined | null, filename?: string) {
  if (!url) return
  const result = await saveImageToDevice(url, filename)
  if (result === 'downloaded') toast.success('ডাউনলোড হয়েছে, বস')
  else if (result === 'opened') toast('ছবি নতুন ট্যাবে খোলা হলো, বস')
}

export function StudioSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M3 9h18" />
    </svg>
  )
}

export function GallerySvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <rect x="14" y="14" width="7" height="7" />
    </svg>
  )
}

export function VideoSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="M10 9l5 3-5 3z" />
    </svg>
  )
}

export function AudioSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <path d="M9 18V6l10-2v12" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="16.5" cy="16" r="2.5" />
    </svg>
  )
}

export function UserSvg({ className }: { className?: string }) {
  return (
    <svg className={cn('h-5 w-5', className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 20c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  )
}
