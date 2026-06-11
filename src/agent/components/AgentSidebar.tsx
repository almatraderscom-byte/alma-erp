'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface Project {
  id: string
  name: string
  description: string | null
  systemInstructions: string | null
}

export interface Conversation {
  id: string
  title: string | null
  projectId: string | null
  archived: boolean
  updatedAt: string
}

interface AgentSidebarProps {
  open: boolean
  onClose: () => void
  activeConvId: string | null
  onSelectConv: (conv: Conversation) => void
  onNewConv: (projectId?: string) => void
  onConvUpdated: () => void
  isMobile: boolean
}

const PROJECT_NONE = '__none__'

export default function AgentSidebar({
  open,
  onClose,
  activeConvId,
  onSelectConv,
  onNewConv,
  onConvUpdated,
  isMobile,
}: AgentSidebarProps) {
  const [projects, setProjects] = useState<Project[]>([])
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [activeProject, setActiveProject] = useState<string>(PROJECT_NONE)
  const [search, setSearch] = useState('')
  const [menuConvId, setMenuConvId] = useState<string | null>(null)
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const [showProjectDialog, setShowProjectDialog] = useState(false)
  const [editProject, setEditProject] = useState<Project | null>(null)

  const loadData = useCallback(async () => {
    const [pRes, cRes] = await Promise.all([
      fetch('/api/assistant/projects'),
      fetch('/api/assistant/conversations'),
    ])
    if (pRes.ok) setProjects(await pRes.json())
    if (cRes.ok) setConversations(await cRes.json())
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const filtered = conversations.filter((c) => {
    if (c.archived) return false
    if (activeProject !== PROJECT_NONE && c.projectId !== activeProject) return false
    if (search && !(c.title ?? '').toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  async function archiveConv(id: string) {
    await fetch(`/api/assistant/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    })
    setMenuConvId(null)
    onConvUpdated()
    loadData()
  }

  async function deleteConv(id: string) {
    await fetch(`/api/assistant/conversations/${id}`, { method: 'DELETE' })
    setDeleteId(null)
    setMenuConvId(null)
    onConvUpdated()
    loadData()
  }

  async function renameConv(id: string, title: string) {
    await fetch(`/api/assistant/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
    setRenameId(null)
    onConvUpdated()
    loadData()
  }

  const sidebarContent = (
    <div className="flex h-full flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <span className="text-sm font-bold text-gold">ALMA Agent</span>
        {isMobile && (
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:text-cream">✕</button>
        )}
      </div>

      {/* Project selector */}
      <div className="border-b border-border p-3">
        <select
          value={activeProject}
          onChange={(e) => setActiveProject(e.target.value)}
          className="w-full rounded-xl bg-card border border-border px-3 py-2 text-xs text-cream focus:outline-none focus:border-gold-dim/60"
        >
          <option value={PROJECT_NONE}>সব কথোপকথন</option>
          {projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onNewConv(activeProject === PROJECT_NONE ? undefined : activeProject)}
            className="flex-1 rounded-xl bg-gold/10 border border-gold-dim/40 px-3 py-2 text-xs font-semibold text-gold-lt hover:bg-gold/20 transition-colors"
          >
            + নতুন চ্যাট
          </button>
          <button
            onClick={() => { setEditProject(null); setShowProjectDialog(true) }}
            className="rounded-xl border border-border px-3 py-2 text-xs text-muted hover:text-cream hover:border-gold-dim/30 transition-colors"
            title="নতুন প্রজেক্ট"
          >
            ⊕
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pt-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="খুঁজুন…"
          className="w-full rounded-xl bg-card border border-border px-3 py-2 text-xs text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60"
        />
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {filtered.length === 0 && (
          <p className="py-8 text-center text-[11px] text-zinc-600">কোনো কথোপকথন নেই</p>
        )}
        {filtered.map((c) => (
          <div
            key={c.id}
            className={cn(
              'group relative rounded-xl px-3 py-2.5 cursor-pointer transition-colors',
              c.id === activeConvId
                ? 'bg-gold/10 border border-gold-dim/40'
                : 'hover:bg-white/[0.04] border border-transparent',
            )}
          >
            {renameId === c.id ? (
              <form
                onSubmit={(e) => { e.preventDefault(); renameConv(c.id, renameValue) }}
                onClick={(e) => e.stopPropagation()}
              >
                <input
                  autoFocus
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onBlur={() => setRenameId(null)}
                  className="w-full rounded-lg bg-card border border-gold-dim/40 px-2 py-1 text-xs text-cream focus:outline-none"
                />
              </form>
            ) : (
              <>
                <div onClick={() => { onSelectConv(c); if (isMobile) onClose() }} className="min-w-0">
                  <p className={cn('truncate text-xs font-medium', c.id === activeConvId ? 'text-gold-lt' : 'text-muted-hi group-hover:text-cream')}>
                    {c.title ?? '(শিরোনাম নেই)'}
                  </p>
                  <p className="mt-0.5 text-[10px] text-zinc-600">
                    {new Date(c.updatedAt).toLocaleDateString('en-BD', { day: '2-digit', month: 'short' })}
                  </p>
                </div>
                {/* Context menu trigger */}
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuConvId(menuConvId === c.id ? null : c.id) }}
                  className="absolute right-2 top-2 hidden rounded-md p-1 text-zinc-600 hover:text-cream group-hover:block"
                >
                  ⋯
                </button>
                {/* Context menu */}
                <AnimatePresence>
                  {menuConvId === c.id && (
                    <motion.div
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className="absolute right-2 top-8 z-50 w-40 rounded-xl border border-border bg-surface shadow-xl"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { setRenameId(c.id); setRenameValue(c.title ?? ''); setMenuConvId(null) }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-muted-hi hover:bg-white/[0.05] hover:text-cream rounded-t-xl"
                      >
                        ✏️ নাম পরিবর্তন
                      </button>
                      <button
                        onClick={() => archiveConv(c.id)}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-muted-hi hover:bg-white/[0.05] hover:text-cream"
                      >
                        📦 আর্কাইভ
                      </button>
                      <button
                        onClick={() => { setDeleteId(c.id); setMenuConvId(null) }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-red-400 hover:bg-red-400/10 rounded-b-xl"
                      >
                        🗑️ মুছুন
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Project edit/create dialog */}
      <AnimatePresence>
        {showProjectDialog && (
          <ProjectDialog
            project={editProject}
            onClose={() => { setShowProjectDialog(false); setEditProject(null) }}
            onSaved={() => { setShowProjectDialog(false); setEditProject(null); loadData() }}
          />
        )}
      </AnimatePresence>

      {/* Delete confirmation */}
      <AnimatePresence>
        {deleteId && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setDeleteId(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mb-2 font-bold text-cream">কথোপকথন মুছবেন?</h3>
              <p className="mb-5 text-sm text-muted-hi">এই কথোপকথন এবং সকল বার্তা স্থায়ীভাবে মুছে যাবে।</p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteId(null)} className="flex-1 rounded-xl border border-border py-2.5 text-sm text-muted-hi hover:text-cream">বাতিল</button>
                <button onClick={() => deleteConv(deleteId)} className="flex-1 rounded-xl bg-red-400/10 border border-red-400/30 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-400/20">মুছুন</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )

  if (isMobile) {
    return (
      <AnimatePresence>
        {open && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-40 bg-black/60"
              onClick={onClose}
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed inset-y-0 left-0 z-50 w-72"
            >
              {sidebarContent}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    )
  }

  return (
    <div className={cn('flex-shrink-0 border-r border-border transition-all duration-200', open ? 'w-64' : 'w-0 overflow-hidden')}>
      {open && sidebarContent}
    </div>
  )
}

// ── Project dialog ─────────────────────────────────────────────────────────

function ProjectDialog({
  project,
  onClose,
  onSaved,
}: {
  project: Project | null
  onClose: () => void
  onSaved: () => void
}) {
  const [name, setName] = useState(project?.name ?? '')
  const [description, setDescription] = useState(project?.description ?? '')
  const [sysInstructions, setSysInstructions] = useState(project?.systemInstructions ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      if (project) {
        await fetch(`/api/assistant/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, systemInstructions: sysInstructions }),
        })
      } else {
        await fetch('/api/assistant/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, description, systemInstructions: sysInstructions }),
        })
      }
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        exit={{ scale: 0.95 }}
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-5 font-bold text-cream">{project ? 'প্রজেক্ট সম্পাদনা' : 'নতুন প্রজেক্ট'}</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">নাম *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ALMA Trading"
              className="w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">বিবরণ</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="সংক্ষিপ্ত বিবরণ"
              className="w-full rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">সিস্টেম নির্দেশনা</label>
            <textarea value={sysInstructions} onChange={(e) => setSysInstructions(e.target.value)}
              placeholder="এই প্রজেক্টের জন্য বিশেষ নির্দেশনা…"
              rows={4}
              className="w-full resize-none rounded-xl bg-card border border-border px-4 py-3 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60"
            />
          </div>
        </div>
        <div className="mt-5 flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border py-2.5 text-sm text-muted-hi hover:text-cream">বাতিল</button>
          <button onClick={save} disabled={!name.trim() || saving}
            className="flex-1 rounded-xl bg-gold/10 border border-gold-dim/40 py-2.5 text-sm font-semibold text-gold-lt hover:bg-gold/20 disabled:opacity-40"
          >
            {saving ? '…' : 'সংরক্ষণ'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
