'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'
import { useSheetDragDismiss } from '@/hooks/useSheetDragDismiss'

export interface Artifact {
  id: string
  conversationId: string
  messageId: string | null
  type: string | null
  title: string | null
  content: string | null
  version: number
  createdAt: string
}

interface AgentArtifactsPanelProps {
  artifacts: Artifact[]
  open: boolean
  onClose: () => void
  isMobile: boolean
  /** Externally-requested artifact to show (file card tap / just-filed document). */
  focusId?: string | null
  /** Bumped by the parent on EVERY open request — re-tapping the same card re-focuses. */
  focusNonce?: number
}

/** Live-renderable artifacts: explicit html/svg type, or html-looking content. */
function isPreviewable(a: Artifact | null): boolean {
  if (!a) return false
  const t = (a.type ?? '').toLowerCase()
  if (t === 'html' || t === 'svg') return true
  const c = a.content ?? ''
  return /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(c)
}

/**
 * Wrap artifact content into a self-contained doc for the sandboxed iframe.
 * The wrapper follows the APP's theme (owner caught the light-mode bug
 * 2026-07-16: dark-hardcoded backgrounds made cards unreadable) — full HTML
 * documents keep their own styling untouched.
 */
function buildSrcDoc(a: Artifact): string {
  const c = a.content ?? ''
  const t = (a.type ?? '').toLowerCase()
  const dark = typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark'
  const bg = dark ? '#141418' : '#FAF9F6'
  const ink = dark ? '#F7F8FC' : '#1d1d2b'
  if (t === 'svg' || /^\s*<svg[\s>]/i.test(c)) {
    return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:${bg}}svg{max-width:100%;max-height:100%;height:auto}</style>${c}`
  }
  if (/^\s*(<!doctype html|<html[\s>])/i.test(c)) return c
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:${bg};color:${ink};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Bengali",system-ui,sans-serif;padding:14px}</style>${c}`
}

function fileExt(type: string | null): string {
  const t = (type ?? '').toLowerCase()
  if (t === 'html') return 'html'
  if (t === 'svg') return 'svg'
  if (t === 'code') return 'txt'
  return 'md'
}

function typeIcon(type: string | null): string {
  const t = (type ?? '').toLowerCase()
  if (t === 'html') return '🌐'
  if (t === 'svg') return '🎨'
  if (t === 'code') return '⌨️'
  return '📄'
}

function typeLabelBn(type: string | null): string {
  const t = (type ?? '').toLowerCase()
  if (t === 'html') return 'ওয়েবপেজ'
  if (t === 'svg') return 'গ্রাফিক'
  if (t === 'code') return 'কোড'
  return 'ডকুমেন্ট'
}

function formatDateBn(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('bn-BD', { day: 'numeric', month: 'long' })
  } catch {
    return ''
  }
}

interface VersionMeta {
  version: number
  title: string | null
  type: string | null
  createdAt: string
}

export default function AgentArtifactsPanel({ artifacts, open, onClose, isMobile, focusId, focusNonce }: AgentArtifactsPanelProps) {
  // ── File-manager navigation (owner ask 2026-07-16: list first, then open) ──
  // 'list' shows every file serially; tapping one opens 'doc'. A chat file-card
  // tap (focusId) deep-links straight into that document.
  const [view, setView] = useState<'list' | 'doc'>('list')
  const [activeId, setActiveId] = useState<string | null>(null)
  const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set())

  useEffect(() => {
    if (focusId) {
      setActiveId(focusId)
      setView('doc')
    }
    // focusNonce bumps on every open request — same card, fresh deep-link.
  }, [focusId, focusNonce])

  const files = useMemo(
    () =>
      artifacts
        .filter((a) => !deletedIds.has(a.id))
        .slice()
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()),
    [artifacts, deletedIds],
  )
  const active = (view === 'doc' ? files.find((a) => a.id === activeId) : null) ?? null
  const previewable = isPreviewable(active)
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const [wide, setWide] = useState(false)
  const { motionProps: sheetDrag, startDrag } = useSheetDragDismiss(onClose)

  function openFile(id: string) {
    setActiveId(id)
    setView('doc')
  }
  function backToList() {
    setView('list')
    setConfirmDeleteId(null)
  }

  // ── Delete (two-tap confirm, owner-only API) ───────────────────────────
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  async function deleteFile(id: string) {
    if (deleteBusy) return
    if (confirmDeleteId !== id) {
      setConfirmDeleteId(id)
      return
    }
    setDeleteBusy(true)
    try {
      const r = await fetch(`/api/assistant/artifacts/${id}`, { method: 'DELETE' })
      if (r.ok) {
        setDeletedIds((s) => new Set(s).add(id))
        if (activeId === id) backToList()
      }
    } finally {
      setDeleteBusy(false)
      setConfirmDeleteId(null)
    }
  }

  // ── Version history (Claude-app parity 2026-07-16) ─────────────────────
  // viewVersion=null → current. Older versions load read-only + restore.
  const [versionList, setVersionList] = useState<VersionMeta[] | null>(null)
  const [viewVersion, setViewVersion] = useState<number | null>(null)
  const [versionBody, setVersionBody] = useState<string | null>(null)
  const [restoreBusy, setRestoreBusy] = useState(false)
  // Restore mutates the active artifact in place (props refresh comes later
  // from the thread's polling) — bump to re-render with the new body now.
  const [, forceRender] = useState(0)

  useEffect(() => {
    // Artifact switched (or its version bumped) — back to current + refetch history.
    setViewVersion(null)
    setVersionBody(null)
    setVersionList(null)
    if (!active?.id || (active.version ?? 1) <= 1) return
    let dead = false
    void fetch(`/api/assistant/artifacts/${active.id}/versions`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!dead && d?.versions) setVersionList(d.versions as VersionMeta[])
      })
      .catch(() => {})
    return () => { dead = true }
  }, [active?.id, active?.version])

  const openVersion = useCallback(
    (v: number | null) => {
      setViewVersion(v)
      setVersionBody(null)
      if (v === null || !active?.id) return
      void fetch(`/api/assistant/artifacts/${active.id}/versions?v=${v}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => setVersionBody(typeof d?.requested?.content === 'string' ? d.requested.content : ''))
        .catch(() => setVersionBody(''))
    },
    [active?.id],
  )

  async function restoreVersion() {
    if (!active?.id || viewVersion === null || restoreBusy) return
    setRestoreBusy(true)
    try {
      const r = await fetch(`/api/assistant/artifacts/${active.id}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore: viewVersion }),
      })
      if (r.ok) {
        // Panel props refresh via the thread's artifact polling; reflect now.
        const updated = (await r.json()) as Artifact
        active.content = updated.content
        active.version = updated.version
        setViewVersion(null)
        setVersionBody(null)
        forceRender((n) => n + 1)
      }
    } finally {
      setRestoreBusy(false)
    }
  }

  const shownContent = viewVersion === null ? active?.content ?? '' : versionBody

  // Default to Preview whenever a renderable artifact becomes active.
  useEffect(() => {
    setMode(previewable ? 'preview' : 'code')
  }, [active?.id, previewable])

  function copyContent() {
    if (shownContent) void navigator.clipboard.writeText(shownContent)
  }

  function downloadContent() {
    if (!shownContent || !active) return
    const blob = new Blob([shownContent], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${active.title ?? 'artifact'}.${fileExt(active.type)}`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Server-rendered exports (browser owns the download; just debounce taps).
  const [exportBusy, setExportBusy] = useState<'pdf' | 'doc' | null>(null)
  function downloadExport(kind: 'pdf' | 'doc') {
    if (!active?.id || exportBusy) return
    setExportBusy(kind)
    const a = document.createElement('a')
    a.href = `/api/assistant/artifacts/${active.id}/${kind}`
    a.click()
    setTimeout(() => setExportBusy(null), 4000)
  }

  function openInNewTab() {
    if (!active) return
    const blob = new Blob([buildSrcDoc(active)], { type: 'text/html' })
    window.open(URL.createObjectURL(blob), '_blank', 'noopener')
  }

  const showPreview = previewable && mode === 'preview' && viewVersion === null

  const listView = (
    <div className="flex-1 overflow-y-auto p-3">
      {files.length === 0 ? (
        <p className="mt-8 text-center text-[12px] text-muted-hi">কোনো ফাইল নেই</p>
      ) : (
        <div className="flex flex-col gap-2">
          {files.map((a) => (
            <div
              key={a.id}
              className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-card/80 px-3 py-2.5 backdrop-blur-md transition-all hover:border-gold-dim/30 hover:bg-gold/5"
            >
              <button onClick={() => openFile(a.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                <span className="text-xl leading-none">{typeIcon(a.type)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-cream">
                    {a.title ?? 'শিরোনামহীন ফাইল'}
                  </span>
                  <span className="mt-0.5 block text-[10.5px] text-muted">
                    {typeLabelBn(a.type)}
                    {(a.version ?? 1) > 1 ? ` · v${a.version}` : ''} · {formatDateBn(a.createdAt)}
                  </span>
                </span>
              </button>
              <button
                onClick={() => void deleteFile(a.id)}
                disabled={deleteBusy}
                title="মুছে ফেলুন"
                className={`flex-shrink-0 rounded-full px-2.5 py-1 text-[10.5px] font-bold transition-all disabled:opacity-50 ${
                  confirmDeleteId === a.id
                    ? 'border border-danger/50 bg-danger/10 text-danger'
                    : isMobile
                      ? 'text-muted opacity-60 active:text-danger' // touch has no hover — keep it visible
                      : 'text-muted opacity-0 hover:text-danger group-hover:opacity-100'
                }`}
              >
                {confirmDeleteId === a.id ? 'নিশ্চিত?' : '🗑'}
              </button>
              <span className="flex-shrink-0 text-muted">›</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )

  const docView = !active ? (
    <p className="mt-8 text-center text-[12px] text-muted-hi">ফাইলটি পাওয়া যায়নি</p>
  ) : (
    <>
      {/* Version strip — only when history exists */}
      {versionList && versionList.length > 0 && (
        <div className="flex items-center gap-1 overflow-x-auto border-b border-border-subtle px-3 py-1.5">
          <span className="mr-1 flex-shrink-0 text-[10px] font-bold uppercase tracking-wide text-muted">সংস্করণ</span>
          <button
            onClick={() => openVersion(null)}
            className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-bold transition-all ${
              viewVersion === null ? 'bg-gold/10 border border-gold-dim/40 text-gold-lt' : 'border border-border-subtle bg-card/80 text-muted-hi hover:text-cream'
            }`}
          >v{active.version} · বর্তমান</button>
          {versionList.map((v) => (
            <button
              key={v.version}
              onClick={() => openVersion(v.version)}
              className={`flex-shrink-0 rounded-full px-2.5 py-0.5 text-[10px] font-medium transition-all ${
                viewVersion === v.version ? 'bg-gold/10 border border-gold-dim/40 text-gold-lt' : 'border border-border-subtle bg-card/80 text-muted-hi hover:text-cream'
              }`}
            >v{v.version}</button>
          ))}
          {viewVersion !== null && (
            <button
              onClick={restoreVersion}
              disabled={restoreBusy}
              className="ml-auto flex-shrink-0 rounded-full border border-gold-dim/40 bg-gold/10 px-3 py-0.5 text-[10px] font-bold text-gold-lt transition-all hover:bg-gold/20 disabled:opacity-50"
            >{restoreBusy ? '⏳' : '↩︎ এটায় ফেরত যান'}</button>
          )}
        </div>
      )}

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {showPreview ? (
          // Live render in a locked-down sandbox: scripts run isolated, with NO
          // access to the parent page, cookies, storage or same-origin requests.
          <iframe
            key={`${active.id}-${active.version}`}
            title={active.title ?? 'preview'}
            sandbox="allow-scripts"
            srcDoc={buildSrcDoc(active)}
            className="min-h-[60dvh] w-full flex-1 border-0 bg-bg-0"
          />
        ) : viewVersion !== null && versionBody === null ? (
          <p className="mt-8 text-center text-[12px] text-muted-hi">সংস্করণ v{viewVersion} আনা হচ্ছে…</p>
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            {viewVersion !== null && (
              <div className="mb-3">
                <span className="rounded-full border border-border-strong px-2 py-0.5 text-[10px] font-medium text-muted-hi">পুরনো সংস্করণ v{viewVersion}</span>
              </div>
            )}
            <div className="rounded-xl border border-border-subtle bg-card/80 p-4 text-sm text-muted-hi backdrop-blur-md">
              {active.type === 'code' || active.type === 'html' || active.type === 'svg' ? (
                <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[13px] text-muted-hi">{shownContent}</pre>
              ) : (
                <AgentMarkdown content={shownContent ?? ''} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      {active.content && (
        <div className="flex gap-2 border-t border-border-subtle p-3">
          <button onClick={copyContent} className="flex-1 rounded-full border border-border-subtle bg-card/80 py-2 text-xs font-semibold text-muted-hi backdrop-blur-md transition-all hover:border-gold-dim/30 hover:bg-gold/5 hover:text-cream">
            📋 কপি
          </button>
          <button onClick={downloadContent} className="flex-1 rounded-full border border-border-subtle bg-card/80 py-2 text-xs font-semibold text-muted-hi backdrop-blur-md transition-all hover:border-gold-dim/30 hover:bg-gold/5 hover:text-cream">
            ⬇️ ফাইল
          </button>
          <button
            onClick={() => downloadExport('pdf')}
            disabled={exportBusy !== null}
            className="flex-1 rounded-full border border-border-subtle bg-card/80 py-2 text-xs font-semibold text-muted-hi backdrop-blur-md transition-all hover:border-gold-dim/30 hover:bg-gold/5 hover:text-cream disabled:opacity-50"
          >
            {exportBusy === 'pdf' ? '⏳ বানাচ্ছি…' : '📄 PDF'}
          </button>
          <button
            onClick={() => downloadExport('doc')}
            disabled={exportBusy !== null}
            className="flex-1 rounded-full border border-border-subtle bg-card/80 py-2 text-xs font-semibold text-muted-hi backdrop-blur-md transition-all hover:border-gold-dim/30 hover:bg-gold/5 hover:text-cream disabled:opacity-50"
          >
            {exportBusy === 'doc' ? '⏳ বানাচ্ছি…' : '📝 Word'}
          </button>
        </div>
      )}
    </>
  )

  const panel = (
    <div className="flex h-full flex-col bg-bg-1/95 backdrop-blur-md">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border-subtle px-4 py-3">
        {view === 'doc' ? (
          <>
            <button
              onClick={backToList}
              title="সব ফাইল"
              className="rounded-lg p-1 text-lg leading-none text-muted transition-colors hover:text-cream"
            >←</button>
            <span className="min-w-0 flex-1 truncate text-sm font-bold text-cream">
              {active ? `${typeIcon(active.type)} ${active.title ?? 'ফাইল'}` : 'ফাইল'}
              {active && (active.version ?? 1) > 1 && <span className="ml-1.5 text-[10px] font-medium text-muted">v{active.version}</span>}
            </span>
            {previewable && (
              <div className="flex flex-shrink-0 rounded-full border border-border-strong bg-card/80 p-0.5">
                <button
                  onClick={() => setMode('preview')}
                  className={`rounded-full px-3 py-1 text-[11px] font-bold transition-all ${
                    mode === 'preview' ? 'bg-gold/10 border border-gold-dim/40 text-gold-lt' : 'text-muted-hi hover:text-cream'
                  }`}
                >👁 প্রিভিউ</button>
                <button
                  onClick={() => setMode('code')}
                  className={`rounded-full px-3 py-1 text-[11px] font-bold transition-all ${
                    mode === 'code' ? 'bg-gold/10 border border-gold-dim/40 text-gold-lt' : 'text-muted-hi hover:text-cream'
                  }`}
                >💻 কোড</button>
              </div>
            )}
          </>
        ) : (
          <span className="flex-1 text-sm font-bold text-cream">
            ফাইলসমূহ <span className="ml-1 text-[11px] font-medium text-muted">({files.length})</span>
          </span>
        )}
        <div className="flex flex-shrink-0 items-center gap-1">
          {view === 'doc' && previewable && (
            <button
              onClick={openInNewTab}
              title="নতুন ট্যাবে খুলুন"
              className="rounded-lg p-1.5 text-muted transition-colors hover:text-cream"
            >↗</button>
          )}
          {!isMobile && (
            <button
              onClick={() => setWide((w) => !w)}
              title={wide ? 'ছোট করুন' : 'বড় করুন'}
              className="rounded-lg p-1.5 text-muted transition-colors hover:text-cream"
            >{wide ? '⇥' : '⇤'}</button>
          )}
          <button onClick={onClose} className="rounded-lg p-1.5 text-lg leading-none text-muted hover:text-cream">✕</button>
        </div>
      </div>

      {view === 'list' ? listView : docView}
    </div>
  )

  if (isMobile) {
    return (
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              className="fixed inset-0 z-[55] bg-black/60 backdrop-blur-sm"
              onClick={onClose}
            />
            <motion.div
              initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed inset-x-0 bottom-0 z-[60] flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl bg-card pb-[env(safe-area-inset-bottom)]"
              {...sheetDrag}
            >
              {/* Grabber — drag down with your finger to dismiss (follows 1:1). */}
              <div
                onPointerDown={startDrag}
                className="flex cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
                role="button"
                aria-label="টেনে বন্ধ করুন"
              >
                <div className="h-1.5 w-12 rounded-full bg-muted/40" />
              </div>
              {panel}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    )
  }

  // Wide mode caps to the window so the chat column never gets crushed on a
  // small desktop window (found live 2026-07-16: 680px overflowed a 1080px
  // window). 640px floor for chat+sidebar.
  const desktopWidth = wide
    ? Math.max(380, Math.min(680, (typeof window !== 'undefined' ? window.innerWidth : 1280) - 640))
    : 380
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: desktopWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0 overflow-hidden border-l border-border-subtle"
          style={{ width: open ? desktopWidth : 0 }}
        >
          {panel}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
