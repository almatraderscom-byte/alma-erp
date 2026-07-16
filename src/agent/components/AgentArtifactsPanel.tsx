'use client'

import { useEffect, useState } from 'react'
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
}

/** Live-renderable artifacts: explicit html/svg type, or html-looking content. */
function isPreviewable(a: Artifact | null): boolean {
  if (!a) return false
  const t = (a.type ?? '').toLowerCase()
  if (t === 'html' || t === 'svg') return true
  const c = a.content ?? ''
  return /^\s*(<!doctype html|<html[\s>]|<svg[\s>])/i.test(c)
}

/** Wrap artifact content into a self-contained doc for the sandboxed iframe. */
function buildSrcDoc(a: Artifact): string {
  const c = a.content ?? ''
  const t = (a.type ?? '').toLowerCase()
  if (t === 'svg' || /^\s*<svg[\s>]/i.test(c)) {
    return `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;height:100%;display:flex;align-items:center;justify-content:center;background:#0c0c10}svg{max-width:100%;max-height:100%;height:auto}</style>${c}`
  }
  if (/^\s*(<!doctype html|<html[\s>])/i.test(c)) return c
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;background:#0c0c10;color:#ECE6DA;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans Bengali",system-ui,sans-serif;padding:14px}</style>${c}`
}

function fileExt(type: string | null): string {
  const t = (type ?? '').toLowerCase()
  if (t === 'html') return 'html'
  if (t === 'svg') return 'svg'
  if (t === 'code') return 'txt'
  return 'md'
}

export default function AgentArtifactsPanel({ artifacts, open, onClose, isMobile, focusId }: AgentArtifactsPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  // A file-card tap (or a just-filed document) steers the panel to that artifact.
  useEffect(() => {
    if (focusId) setActiveId(focusId)
  }, [focusId])
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[artifacts.length - 1] ?? null
  const previewable = isPreviewable(active)
  const [mode, setMode] = useState<'preview' | 'code'>('preview')
  const { motionProps: sheetDrag, startDrag } = useSheetDragDismiss(onClose)

  // Default to Preview whenever a renderable artifact becomes active.
  useEffect(() => {
    setMode(previewable ? 'preview' : 'code')
  }, [active?.id, previewable])

  function copyContent() {
    if (active?.content) void navigator.clipboard.writeText(active.content)
  }

  function downloadContent() {
    if (!active?.content) return
    const blob = new Blob([active.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${active.title ?? 'artifact'}.${fileExt(active.type)}`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Client-report PDF export (owner ask 2026-07-16): the markdown artifact
  // renders through the Aura design system into a designed A4 PDF — what the
  // owner actually hands a client. Everything loads lazily so the chat bundle
  // pays nothing until the first tap.
  const [pdfBusy, setPdfBusy] = useState(false)
  const pdfable = Boolean(active?.content) && !previewable
  async function downloadPdf() {
    if (!active?.content || pdfBusy) return
    setPdfBusy(true)
    try {
      const [{ pdf }, { ensurePdfFonts }, { parseMarkdownBlocks }, { ClientReportDocument }, React] =
        await Promise.all([
          import('@react-pdf/renderer'),
          import('@/lib/pdf/fonts'),
          import('@/lib/pdf/markdown-blocks'),
          import('@/components/pdf/ClientReportDocument'),
          import('react'),
        ])
      await ensurePdfFonts()
      let blocks = parseMarkdownBlocks(active.content)
      let title = active.title ?? 'Report'
      const metaLines: string[] = []
      // The document's own H1 becomes the PDF title; a leading "প্রস্তুত:" line
      // becomes header meta — no duplicated headings in the designed output.
      if (blocks[0]?.kind === 'heading' && blocks[0].level === 1) {
        title = blocks[0].text
        blocks = blocks.slice(1)
      }
      if (blocks[0]?.kind === 'paragraph') {
        const first = blocks[0].spans.map((s) => s.text).join('')
        if (/^(প্রস্তুত|Prepared|Date|তারিখ)/.test(first) && first.length < 120) {
          metaLines.push(first)
          blocks = blocks.slice(1)
        }
      }
      const doc = React.createElement(ClientReportDocument, {
        model: { title, metaLines, blocks },
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const blob = await pdf(doc as any).toBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${(active.title ?? 'report').replace(/[\\/:*?"<>|]/g, '-')}.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('[artifacts] PDF export failed:', err)
      alert('PDF বানাতে সমস্যা হয়েছে — আবার চেষ্টা করুন।')
    } finally {
      setPdfBusy(false)
    }
  }

  const showPreview = previewable && mode === 'preview'

  const panel = (
    <div className="flex h-full flex-col bg-[rgba(12,12,16,0.8)]">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-white/[0.04] px-4 py-3">
        <span className="text-sm font-bold text-cream">আর্টিফ্যাক্ট</span>
        {previewable && (
          <div className="ml-auto flex rounded-full border border-white/[0.08] bg-card/80 p-0.5">
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
        <button onClick={onClose} className={`rounded-lg p-1.5 text-muted hover:text-cream text-lg leading-none ${previewable ? '' : 'ml-auto'}`}>✕</button>
      </div>

      {/* Artifact list tabs */}
      {artifacts.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b border-white/[0.04] px-3 py-2">
          {artifacts.map((a) => (
            <button
              key={a.id}
              onClick={() => setActiveId(a.id)}
              className={`flex-shrink-0 rounded-full px-3 py-1.5 text-[11px] font-medium backdrop-blur-md transition-all ${
                (activeId ? activeId === a.id : a.id === artifacts[artifacts.length - 1]?.id)
                  ? 'bg-gold/10 border border-gold-dim/40 text-gold-lt shadow-[0_0_10px_rgba(201,168,76,0.1)]'
                  : 'border border-white/[0.06] bg-card/80 text-muted-hi hover:text-cream hover:border-gold-dim/30'
              }`}
            >
              {a.title ?? `আর্টিফ্যাক্ট ${artifacts.indexOf(a) + 1}`}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex min-h-0 flex-1 flex-col">
        {!active ? (
          <p className="text-center text-[12px] text-muted-hi mt-8">কোনো আর্টিফ্যাক্ট নেই</p>
        ) : showPreview ? (
          // Live render in a locked-down sandbox: scripts run isolated, with NO
          // access to the parent page, cookies, storage or same-origin requests.
          <iframe
            key={`${active.id}-${active.version}`}
            title={active.title ?? 'preview'}
            sandbox="allow-scripts"
            srcDoc={buildSrcDoc(active)}
            className="min-h-[60dvh] w-full flex-1 border-0 bg-[#0c0c10]"
          />
        ) : (
          <div className="flex-1 overflow-y-auto p-4">
            {active.title && <h3 className="mb-3 text-sm font-bold text-cream">{active.title}</h3>}
            <div className="rounded-xl border border-white/[0.06] bg-[rgba(8,8,12,0.7)] backdrop-blur-md p-4 text-sm text-muted-hi">
              {active.type === 'code' || active.type === 'html' || active.type === 'svg' ? (
                <pre className="overflow-x-auto font-mono text-[13px] text-zinc-300 whitespace-pre-wrap">{active.content}</pre>
              ) : (
                <AgentMarkdown content={active.content ?? ''} />
              )}
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      {active?.content && (
        <div className="flex gap-2 border-t border-white/[0.04] p-3">
          <button onClick={copyContent} className="flex-1 rounded-full border border-white/[0.06] bg-card/80 backdrop-blur-md py-2 text-xs font-semibold text-muted-hi transition-all hover:text-cream hover:border-gold-dim/30 hover:bg-gold/5 hover:shadow-[0_0_10px_rgba(201,168,76,0.1)]">
            📋 কপি
          </button>
          <button onClick={downloadContent} className="flex-1 rounded-full border border-white/[0.06] bg-card/80 backdrop-blur-md py-2 text-xs font-semibold text-muted-hi transition-all hover:text-cream hover:border-gold-dim/30 hover:bg-gold/5 hover:shadow-[0_0_10px_rgba(201,168,76,0.1)]">
            ⬇️ ডাউনলোড
          </button>
          {pdfable && (
            <button
              onClick={() => void downloadPdf()}
              disabled={pdfBusy}
              className="flex-1 rounded-full border border-white/[0.06] bg-card/80 backdrop-blur-md py-2 text-xs font-semibold text-muted-hi transition-all hover:text-cream hover:border-gold-dim/30 hover:bg-gold/5 hover:shadow-[0_0_10px_rgba(201,168,76,0.1)] disabled:opacity-50"
            >
              {pdfBusy ? '⏳ বানাচ্ছি…' : '📄 PDF'}
            </button>
          )}
        </div>
      )}
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
              className="fixed inset-x-0 bottom-0 z-[60] max-h-[85dvh] rounded-t-2xl overflow-hidden pb-[env(safe-area-inset-bottom)] bg-card"
              {...sheetDrag}
            >
              {/* Grabber — drag down with your finger to dismiss (follows 1:1). */}
              <div
                onPointerDown={startDrag}
                className="flex cursor-grab touch-none justify-center pb-1 pt-2.5 active:cursor-grabbing"
                role="button"
                aria-label="টেনে বন্ধ করুন"
              >
                <div className="h-1.5 w-12 rounded-full bg-white/20" />
              </div>
              {panel}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    )
  }

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 380, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0 border-l border-white/[0.04] overflow-hidden"
          style={{ width: open ? 380 : 0 }}
        >
          {panel}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
