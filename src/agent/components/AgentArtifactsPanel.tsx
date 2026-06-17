'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import AgentMarkdown from './AgentMarkdown'

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
}

export default function AgentArtifactsPanel({ artifacts, open, onClose, isMobile }: AgentArtifactsPanelProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const active = artifacts.find((a) => a.id === activeId) ?? artifacts[artifacts.length - 1] ?? null

  function copyContent() {
    if (active?.content) void navigator.clipboard.writeText(active.content)
  }

  function downloadContent() {
    if (!active?.content) return
    const ext = active.type === 'code' ? 'txt' : 'md'
    const blob = new Blob([active.content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${active.title ?? 'artifact'}.${ext}`
    a.click()
    URL.revokeObjectURL(url)
  }

  const panel = (
    <div className="flex h-full flex-col bg-[rgba(12,12,16,0.8)] backdrop-blur-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/[0.04] px-4 py-3">
        <span className="text-sm font-bold text-cream">আর্টিফ্যাক্ট</span>
        <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:text-cream text-lg leading-none">✕</button>
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
                  : 'border border-white/[0.06] bg-white/[0.03] text-muted-hi hover:text-cream hover:border-gold-dim/30'
              }`}
            >
              {a.title ?? `আর্টিফ্যাক্ট ${artifacts.indexOf(a) + 1}`}
            </button>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-4">
        {!active ? (
          <p className="text-center text-[12px] text-zinc-600 mt-8">কোনো আর্টিফ্যাক্ট নেই</p>
        ) : (
          <>
            {active.title && (
              <h3 className="mb-3 text-sm font-bold text-cream">{active.title}</h3>
            )}
            <div className="rounded-xl border border-white/[0.06] bg-[rgba(8,8,12,0.7)] backdrop-blur-md p-4 text-sm text-muted-hi">
              {active.type === 'code' ? (
                <pre className="overflow-x-auto font-mono text-[13px] text-zinc-300 whitespace-pre-wrap">
                  {active.content}
                </pre>
              ) : (
                <AgentMarkdown content={active.content ?? ''} />
              )}
            </div>
          </>
        )}
      </div>

      {/* Actions */}
      {active?.content && (
        <div className="flex gap-2 border-t border-white/[0.04] p-3">
          <button onClick={copyContent} className="flex-1 rounded-full border border-white/[0.06] bg-white/[0.03] backdrop-blur-md py-2 text-xs font-semibold text-muted-hi transition-all hover:text-cream hover:border-gold-dim/30 hover:bg-gold/5 hover:shadow-[0_0_10px_rgba(201,168,76,0.1)]">
            📋 কপি
          </button>
          <button onClick={downloadContent} className="flex-1 rounded-full border border-white/[0.06] bg-white/[0.03] backdrop-blur-md py-2 text-xs font-semibold text-muted-hi transition-all hover:text-cream hover:border-gold-dim/30 hover:bg-gold/5 hover:shadow-[0_0_10px_rgba(201,168,76,0.1)]">
            ⬇️ ডাউনলোড
          </button>
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
              className="fixed inset-x-0 bottom-0 z-[60] max-h-[85dvh] rounded-t-2xl overflow-hidden pb-[env(safe-area-inset-bottom)]"
            >
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
          animate={{ width: 320, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="flex-shrink-0 border-l border-white/[0.04] overflow-hidden"
          style={{ width: open ? 320 : 0 }}
        >
          {panel}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
