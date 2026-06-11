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
  const [tab, setTab] = useState<'chats' | 'memory'>('chats')
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
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)

  const loadData = useCallback(async (append = false, cursor?: string | null) => {
    if (append) setLoadingMore(true)
    else { setLoading(true); setLoadError(null) }

    try {
      const convUrl = cursor
        ? `/api/assistant/conversations?paginated=true&limit=30&cursor=${encodeURIComponent(cursor)}`
        : '/api/assistant/conversations?paginated=true&limit=30'

      const [pRes, cRes] = await Promise.all([
        append ? Promise.resolve(null) : fetch('/api/assistant/projects'),
        fetch(convUrl),
      ])

      if (!append && pRes && !pRes.ok) throw new Error('প্রজেক্ট লোড ব্যর্থ')
      if (!cRes.ok) throw new Error('কথোপকথন লোড ব্যর্থ')

      if (!append && pRes?.ok) setProjects(await pRes.json())

      const cData = await cRes.json() as { conversations: Conversation[]; nextCursor: string | null }
      setConversations((prev) => append ? [...prev, ...cData.conversations] : cData.conversations)
      setNextCursor(cData.nextCursor)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'লোড ব্যর্থ')
    } finally {
      setLoading(false)
      setLoadingMore(false)
    }
  }, [])

  useEffect(() => { void loadData() }, [loadData])

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
    <div className={cn('flex h-full flex-col bg-surface', isMobile && 'safe-top')}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-gold">ALMA Agent</span>
          <a href="/agent/costs" className="rounded-md border border-border px-1.5 py-0.5 text-[9px] text-muted hover:text-gold-lt" title="খরচ ড্যাশবোর্ড">
            $
          </a>
        </div>
        {isMobile && (
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:text-cream">✕</button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setTab('chats')}
          className={cn('flex-1 py-2 text-xs font-semibold transition-colors', tab === 'chats' ? 'text-gold-lt border-b-2 border-gold' : 'text-muted hover:text-cream')}
        >
          💬 চ্যাট
        </button>
        <button
          onClick={() => setTab('memory')}
          className={cn('flex-1 py-2 text-xs font-semibold transition-colors', tab === 'memory' ? 'text-gold-lt border-b-2 border-gold' : 'text-muted hover:text-cream')}
        >
          🧠 স্মৃতি
        </button>
      </div>

      {tab === 'memory' ? (
        <MemoryView />
      ) : (
        <>
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
        {loading && (
          <p className="py-8 text-center text-[11px] text-zinc-500 animate-pulse">লোড হচ্ছে…</p>
        )}
        {!loading && loadError && (
          <div className="py-6 text-center space-y-2">
            <p className="text-[11px] text-red-400">{loadError}</p>
            <button
              onClick={() => void loadData()}
              className="rounded-lg border border-border px-3 py-1.5 text-[11px] text-muted-hi hover:text-cream"
            >
              আবার চেষ্টা
            </button>
          </div>
        )}
        {!loading && !loadError && filtered.length === 0 && (
          <p className="py-8 text-center text-[11px] text-zinc-600">কোনো কথোপকথন নেই — নতুন চ্যাট শুরু করুন</p>
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
        {!loading && !loadError && nextCursor && (
          <button
            onClick={() => void loadData(true, nextCursor)}
            disabled={loadingMore}
            className="mt-2 w-full rounded-xl border border-border py-2 text-[11px] text-muted-hi hover:text-cream disabled:opacity-50"
          >
            {loadingMore ? 'লোড হচ্ছে…' : 'আরও দেখুন'}
          </button>
        )}
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
        </>
      )}
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

// ── Memory view ────────────────────────────────────────────────────────────

interface MemoryRow {
  id: string
  scope: string
  key: string | null
  content: string
  pinned: boolean
  createdAt: string
}

function MemoryView() {
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [scopeFilter, setScopeFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [deleteMemId, setDeleteMemId] = useState<string | null>(null)

  const loadMemories = useCallback(async () => {
    setLoading(true)
    try {
      const url = scopeFilter !== 'all' ? `/api/assistant/memory?scope=${scopeFilter}` : '/api/assistant/memory'
      const res = await fetch(url)
      if (res.ok) setMemories(await res.json())
    } finally {
      setLoading(false)
    }
  }, [scopeFilter])

  useEffect(() => { loadMemories() }, [loadMemories])

  async function togglePin(id: string, pinned: boolean) {
    await fetch(`/api/assistant/memory/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: !pinned }),
    })
    loadMemories()
  }

  async function deleteMem(id: string) {
    await fetch(`/api/assistant/memory/${id}`, { method: 'DELETE' })
    setDeleteMemId(null)
    loadMemories()
  }

  const SCOPE_LABELS: Record<string, string> = { personal: 'ব্যক্তিগত', business: 'ব্যবসা', staff: 'স্টাফ' }

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Scope filter */}
      <div className="border-b border-border px-3 py-2">
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="w-full rounded-xl bg-card border border-border px-3 py-2 text-xs text-cream focus:outline-none focus:border-gold-dim/60"
        >
          <option value="all">সব ক্যাটাগরি</option>
          <option value="personal">ব্যক্তিগত</option>
          <option value="business">ব্যবসা</option>
          <option value="staff">স্টাফ</option>
        </select>
      </div>

      {/* Memory list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {loading && <p className="py-6 text-center text-[11px] text-zinc-600">লোড হচ্ছে…</p>}
        {!loading && memories.length === 0 && (
          <p className="py-8 text-center text-[11px] text-zinc-600">কোনো স্মৃতি নেই</p>
        )}
        {memories.map((m) => (
          <div
            key={m.id}
            className={cn(
              'rounded-xl border p-3 text-[11px] transition-colors',
              m.pinned ? 'border-gold-dim/40 bg-gold/5' : 'border-border bg-card',
            )}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                m.scope === 'personal' ? 'bg-blue-400/10 text-blue-400' :
                m.scope === 'business' ? 'bg-gold/10 text-gold-lt' :
                'bg-purple-400/10 text-purple-400'
              )}>
                {SCOPE_LABELS[m.scope] ?? m.scope}
              </span>
              {m.key && <span className="text-zinc-600">{m.key}</span>}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => togglePin(m.id, m.pinned)}
                  title={m.pinned ? 'পিন সরান' : 'পিন করুন'}
                  className={cn('rounded p-0.5 transition-colors', m.pinned ? 'text-gold' : 'text-zinc-600 hover:text-gold')}
                >
                  📌
                </button>
                <button
                  onClick={() => setDeleteMemId(m.id)}
                  className="rounded p-0.5 text-zinc-600 hover:text-red-400 transition-colors"
                  title="মুছুন"
                >
                  🗑️
                </button>
              </div>
            </div>
            <p className="leading-relaxed text-muted-hi line-clamp-3">{m.content}</p>
            <p className="mt-1.5 text-[9px] text-zinc-600">
              {new Date(m.createdAt).toLocaleDateString('en-BD', { day: '2-digit', month: 'short', year: '2-digit' })}
            </p>
          </div>
        ))}
      </div>

      {/* Delete confirmation */}
      <AnimatePresence>
        {deleteMemId && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
            onClick={() => setDeleteMemId(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="w-full max-w-sm rounded-2xl border border-border bg-surface p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mb-2 font-bold text-cream">স্মৃতি মুছবেন?</h3>
              <p className="mb-5 text-sm text-muted-hi">এই তথ্য স্থায়ীভাবে মুছে যাবে।</p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteMemId(null)} className="flex-1 rounded-xl border border-border py-2.5 text-sm text-muted-hi hover:text-cream">বাতিল</button>
                <button onClick={() => deleteMem(deleteMemId)} className="flex-1 rounded-xl bg-red-400/10 border border-red-400/30 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-400/20">মুছুন</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
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
