'use client'

import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'

export interface Project {
  id: string
  name: string
  description: string | null
  systemInstructions: string | null
  businessId?: string | null
}

export interface Conversation {
  id: string
  title: string | null
  projectId: string | null
  modelId?: string | null
  source?: string | null
  archived: boolean
  updatedAt: string
  businessId?: string | null
}

function businessBadgeStyle(businessId: string | null | undefined): { label: string; cls: string } | null {
  if (businessId === 'ALMA_TRADING') {
    return { label: 'Trading', cls: 'tone-amber' }
  }
  if (businessId === 'ALMA_LIFESTYLE') {
    return { label: 'Lifestyle', cls: 'tone-green' }
  }
  return null
}

interface AgentSidebarProps {
  open: boolean
  onClose: () => void
  activeConvId: string | null
  onSelectConv: (conv: Conversation) => void
  onNewConv: (projectId?: string) => void
  onEnterPersonal?: () => void
  personalActive?: boolean
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
  onEnterPersonal,
  personalActive = false,
  onConvUpdated,
  isMobile,
}: AgentSidebarProps) {
  const [tab, setTab] = useState<'chats' | 'memory'>('chats')
  const [chatView, setChatView] = useState<'regular' | 'office'>('regular')
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

  const officeCount = conversations.filter((c) => !c.archived && c.source === 'day_shift').length

  const filtered = conversations
    .filter((c) => {
      if (c.archived) return false
      // Keep office-shift history in its own view so it doesn't clutter the
      // owner's day-to-day chats.
      const isOffice = c.source === 'day_shift'
      if (chatView === 'office' ? !isOffice : isOffice) return false
      if (activeProject !== PROJECT_NONE && c.projectId !== activeProject) return false
      if (search && !(c.title ?? '').toLowerCase().includes(search.toLowerCase())) return false
      return true
    })
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())

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
    <div className={cn('glass-panel flex h-full flex-col rounded-none border-y-0 border-l-0 border-r border-white/[0.08]', isMobile && 'safe-top')}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-[#E07A5F]">
            ALMA Agent
          </span>
          <a
            href="/agent/costs"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-[#E07A5F]/25 hover:bg-[#E07A5F]/5 hover:text-[#E07A5F]"
            title="খরচ ড্যাশবোর্ড"
          >
            $
          </a>
          <a
            href="/agent/staff-monitor"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-[#E07A5F]/25 hover:bg-[#E07A5F]/5 hover:text-[#E07A5F]"
            title="LIVE Business"
          >
            📊
          </a>
          <a
            href="/agent/creative-studio"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-[#81B29A]/40 hover:bg-[#81B29A]/10 hover:text-[#2d6a4f]"
            title="Creative Studio — Fashion AI"
          >
            🎨
          </a>
          <a
            href="/agent/trading-staff"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-amber-300/40 hover:bg-amber-500/10 hover:text-amber-400"
            title="Trading Staff"
          >
            ₿
          </a>
          <a
            href="/agent/catalog-images"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-[#3D8BFD]/40 hover:bg-[#3D8BFD]/10 hover:text-[#3D8BFD]"
            title="Product Images — ছবি আপলোড"
          >
            📷
          </a>
          <a
            href="/agent/growth"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-[#4285F4]/40 hover:bg-[#4285F4]/10 hover:text-[#4285F4]"
            title="Growth — Google সংযোগ (Search Console)"
          >
            🔍
          </a>
          <a
            href="/agent?monitor=graph"
            className="rounded-full border border-border-subtle bg-white/[0.04] px-2 py-0.5 text-[9px] text-muted transition-all hover:border-[#9D8CFF]/40 hover:bg-[#9D8CFF]/10 hover:text-[#9D8CFF]"
            title="Graph Health — রোলআউট/kill-switch অবস্থা"
          >
            🧬
          </a>
        </div>
        {isMobile && (
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted hover:text-muted-hi">✕</button>
        )}
      </div>

      {onEnterPersonal && (
        <div className="border-b border-border-subtle px-3 py-2">
          <button
            type="button"
            onClick={onEnterPersonal}
            className={cn(
              'w-full rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition-all',
              personalActive
                ? 'tone-green shadow-sm'
                : 'border-border-subtle bg-white/[0.04] text-cream hover:border-emerald-200 hover:bg-green-500/10',
            )}
          >
            🤲 ব্যক্তিগত
            {personalActive && <span className="mt-0.5 block text-[10px] font-normal">মোড সক্রিয়</span>}
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div className="flex border-b border-border-subtle">
        <button
          onClick={() => setTab('chats')}
          className={cn(
            'flex-1 py-2 text-xs font-semibold transition-all',
            tab === 'chats'
              ? 'text-[#E07A5F] border-b-2 border-[#E07A5F]'
              : 'text-muted hover:bg-white/[0.02] hover:text-muted-hi',
          )}
        >
          💬 চ্যাট
        </button>
        <button
          onClick={() => setTab('memory')}
          className={cn(
            'flex-1 py-2 text-xs font-semibold transition-all',
            tab === 'memory'
              ? 'text-[#E07A5F] border-b-2 border-[#E07A5F]'
              : 'text-muted hover:bg-white/[0.02] hover:text-muted-hi',
          )}
        >
          🧠 স্মৃতি
        </button>
      </div>

      {tab === 'memory' ? (
        <MemoryView />
      ) : (
        <>
      {/* Project selector */}
      <div className="border-b border-border-subtle p-3">
        <select
          value={activeProject}
          onChange={(e) => setActiveProject(e.target.value)}
          className="w-full rounded-xl bg-white/[0.04] border border-border-subtle px-3 py-2 text-xs text-cream focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20"
        >
          <option value={PROJECT_NONE}>সব কথোপকথন</option>
          {projects.map((p) => {
            const badge = businessBadgeStyle(p.businessId)
            return (
              <option key={p.id} value={p.id}>
                {p.name}{badge ? ` · ${badge.label}` : ''}
              </option>
            )
          })}
        </select>
        {(() => {
          const active = projects.find((p) => p.id === activeProject)
          const badge = active ? businessBadgeStyle(active.businessId) : null
          if (!badge) return null
          return (
            <div className={cn('mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium border', badge.cls)}>
              <span>{badge.label}</span>
            </div>
          )
        })()}
        <div className="mt-2 flex gap-2">
          <button
            onClick={() => onNewConv(activeProject === PROJECT_NONE ? undefined : activeProject)}
            className="flex-1 rounded-xl bg-[#E07A5F]/10 border border-[#E07A5F]/25 px-3 py-2 text-xs font-semibold text-[#E07A5F] transition-all hover:bg-[#E07A5F]/15 hover:shadow-sm"
          >
            + নতুন চ্যাট
          </button>
          <button
            onClick={() => { setEditProject(null); setShowProjectDialog(true) }}
            className="rounded-xl border border-border-subtle bg-white/[0.04] px-3 py-2 text-xs text-muted transition-all hover:text-cream hover:border-[#E07A5F]/25"
            title="নতুন প্রজেক্ট"
          >
            ⊕
          </button>
        </div>
      </div>

      {/* Regular chats vs Office-shift history */}
      <div className="px-3 pt-3">
        <div className="flex gap-1 rounded-full border border-border bg-white/[0.03] p-1">
          <button
            type="button"
            onClick={() => setChatView('regular')}
            className={cn(
              'flex-1 rounded-full py-1.5 text-[12px] font-semibold transition-all',
              chatView === 'regular' ? 'bg-card/80 text-cream shadow-sm' : 'text-muted hover:text-cream',
            )}
          >
            💬 চ্যাট
          </button>
          <button
            type="button"
            onClick={() => setChatView('office')}
            className={cn(
              'flex-1 rounded-full py-1.5 text-[12px] font-semibold transition-all',
              chatView === 'office' ? 'bg-card/80 text-cream shadow-sm' : 'text-muted hover:text-cream',
            )}
          >
            🏢 অফিস{officeCount > 0 ? ` (${officeCount})` : ''}
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="px-3 pt-3">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="খুঁজুন…"
          className="w-full rounded-xl bg-white/[0.04] border border-border-subtle px-3 py-2 text-base text-cream placeholder-gray-400 focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20 md:text-xs"
        />
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-1">
        {loading && (
          <p className="py-8 text-center text-[11px] text-muted animate-pulse">লোড হচ্ছে…</p>
        )}
        {!loading && loadError && (
          <div className="py-6 text-center space-y-2">
            <p className="text-[11px] text-red-500">{loadError}</p>
            <button
              onClick={() => void loadData()}
              className="rounded-lg border border-border-subtle bg-white/[0.04] px-3 py-1.5 text-[11px] text-muted-hi hover:text-cream"
            >
              আবার চেষ্টা
            </button>
          </div>
        )}
        {!loading && !loadError && filtered.length === 0 && (
          <p className="py-8 text-center text-[11px] text-muted">কোনো কথোপকথন নেই — নতুন চ্যাট শুরু করুন</p>
        )}
        {filtered.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => {
              if (renameId === c.id) return
              onSelectConv(c)
              if (isMobile) onClose()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onSelectConv(c)
                if (isMobile) onClose()
              }
            }}
            className={cn(
              'group relative rounded-xl px-3 py-2.5 cursor-pointer transition-all',
              c.id === activeConvId
                ? 'bg-[#E07A5F]/[0.08] border border-[#E07A5F]/20 shadow-sm'
                : 'hover:bg-white/[0.02] border border-transparent',
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
                  className="w-full rounded-lg bg-card/80 border border-[#E07A5F]/30 px-2 py-1 text-xs text-cream focus:outline-none"
                />
              </form>
            ) : (
              <>
                <div className="min-w-0 pr-6">
                  <p className={cn('truncate text-xs font-medium', c.id === activeConvId ? 'text-[#E07A5F]' : 'text-cream group-hover:text-cream')}>
                    {c.source === 'day_shift' && <span className="mr-1">🏢</span>}
                    {c.title ?? '(শিরোনাম নেই)'}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted">
                    {c.source === 'day_shift' ? 'অফিস লাইভ · ' : ''}
                    {new Date(c.updatedAt).toLocaleDateString('en-BD', { day: '2-digit', month: 'short' })}
                  </p>
                </div>
                {/* Context menu trigger */}
                <button
                  onClick={(e) => { e.stopPropagation(); setMenuConvId(menuConvId === c.id ? null : c.id) }}
                  className="absolute right-2 top-2 hidden rounded-md p-1 text-muted hover:text-muted-hi group-hover:block"
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
                      className="absolute right-2 top-8 z-50 w-40 rounded-xl border border-border bg-card/80 shadow-lg"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        onClick={() => { setRenameId(c.id); setRenameValue(c.title ?? ''); setMenuConvId(null) }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-muted-hi hover:bg-white/[0.03] hover:text-cream rounded-t-xl"
                      >
                        ✏️ নাম পরিবর্তন
                      </button>
                      <button
                        onClick={() => archiveConv(c.id)}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-muted-hi hover:bg-white/[0.03] hover:text-cream"
                      >
                        📦 আর্কাইভ
                      </button>
                      <button
                        onClick={() => { setDeleteId(c.id); setMenuConvId(null) }}
                        className="flex w-full items-center gap-2 px-3 py-2.5 text-xs text-red-500 hover:bg-red-500/10 rounded-b-xl"
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
            className="mt-2 w-full rounded-xl border border-border-subtle bg-white/[0.04] py-2 text-[11px] text-muted-hi hover:text-cream disabled:opacity-50"
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setDeleteId(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0.95 }}
              className="w-full max-w-sm rounded-2xl border border-border bg-card/80 shadow-xl p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mb-2 font-bold text-cream">কথোপকথন মুছবেন?</h3>
              <p className="mb-5 text-sm text-muted">এই কথোপকথন এবং সকল বার্তা স্থায়ীভাবে মুছে যাবে।</p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteId(null)} className="flex-1 rounded-xl border border-border-subtle bg-white/[0.04] py-2.5 text-sm text-muted-hi hover:text-cream">বাতিল</button>
                <button onClick={() => deleteConv(deleteId)} className="flex-1 rounded-xl tone-red border py-2.5 text-sm font-semibold hover:bg-red-500/20">মুছুন</button>
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
              className="fixed inset-0 z-[55] bg-black/30 backdrop-blur-sm"
              onClick={onClose}
            />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed inset-y-0 left-0 z-[60] w-72 overflow-hidden rounded-r-[24px] shadow-[0_4px_24px_rgba(0,0,0,0.10)]"
            >
              {sidebarContent}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    )
  }

  return (
    <div className={cn('flex-shrink-0 border-r border-border-subtle transition-all duration-200', open ? 'w-64' : 'w-0 overflow-hidden')}>
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

function LearnedRulesPanel() {
  const [rules, setRules] = useState<Array<{
    id: string; kind: string; domain: string; text: string; timesApplied: number
  }>>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    void fetch('/api/assistant/learned-rules')
      .then((r) => (r.ok ? r.json() : { rules: [] }))
      .then((d) => setRules(d.rules ?? []))
      .catch(() => setRules([]))
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <p className="px-3 py-2 text-[10px] text-muted">শেখা নিয়ম লোড…</p>
  if (!rules.length) return null

  return (
    <div className="border-b border-border-subtle px-3 py-2">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#E07A5F]">শেখা নিয়ম</p>
      <div className="max-h-40 space-y-1.5 overflow-y-auto">
        {rules.slice(0, 12).map((r) => (
          <div key={`${r.kind}-${r.id}`} className="rounded-lg bg-white/[0.04] px-2 py-1.5 text-[10px] text-cream">
            <span className="text-[#E07A5F]/70">[{r.domain}]</span>{' '}
            {r.text.slice(0, 100)}{r.text.length > 100 ? '…' : ''}
            {r.timesApplied > 0 && (
              <span className="ml-1 text-muted">· {r.timesApplied}×</span>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function MemoryView() {
  const [memories, setMemories] = useState<MemoryRow[]>([])
  const [financeSummary, setFinanceSummary] = useState<{
    balances: Array<{ person: string; display: string; balances: Record<string, number> }>
    monthExpensesByCategory: Array<{ display: string; total: number; currency: string; category: string }>
  } | null>(null)
  const [scopeFilter, setScopeFilter] = useState<string>('all')
  const [loading, setLoading] = useState(true)
  const [deleteMemId, setDeleteMemId] = useState<string | null>(null)

  const loadMemories = useCallback(async () => {
    setLoading(true)
    try {
      const url = scopeFilter !== 'all' ? `/api/assistant/memory?scope=${scopeFilter}` : '/api/assistant/memory'
      const [memRes, finRes] = await Promise.all([
        fetch(url),
        fetch('/api/assistant/memory/finance-summary'),
      ])
      if (memRes.ok) {
        setMemories(await memRes.json())
      } else {
        console.error('[memory] load failed', memRes.status)
        setMemories([])
      }
      if (finRes.ok) {
        setFinanceSummary(await finRes.json())
      } else {
        setFinanceSummary(null)
      }
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
      <LearnedRulesPanel />
      {/* Scope filter */}
      <div className="border-b border-border-subtle px-3 py-2">
        <select
          value={scopeFilter}
          onChange={(e) => setScopeFilter(e.target.value)}
          className="w-full rounded-xl bg-white/[0.04] border border-border-subtle px-3 py-2 text-xs text-cream focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20"
        >
          <option value="all">সব ক্যাটাগরি</option>
          <option value="personal">ব্যক্তিগত</option>
          <option value="business">ব্যবসা</option>
          <option value="staff">স্টাফ</option>
        </select>
      </div>

      {/* Memory list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {financeSummary && (financeSummary.balances.length > 0 || financeSummary.monthExpensesByCategory.length > 0) && (
          <div className="mb-3 rounded-xl border border-[#D4A84B]/20 bg-[#D4A84B]/[0.04] p-3 text-[11px] shadow-sm">
            <p className="mb-2 font-semibold text-[#D4A84B]">💰 আর্থিক সারসংক্ষেপ</p>
            {financeSummary.balances.length > 0 && (
              <div className="mb-2">
                <p className="mb-1 text-[10px] text-muted">পাওনা/দেনা (ব্যক্তি অনুযায়ী)</p>
                <ul className="space-y-1">
                  {financeSummary.balances.slice(0, 8).map((b) => (
                    <li key={b.person} className="text-cream leading-snug">{b.display || b.person}</li>
                  ))}
                </ul>
              </div>
            )}
            {financeSummary.monthExpensesByCategory.length > 0 && (
              <div>
                <p className="mb-1 text-[10px] text-muted">এই মাসের খরচ (ক্যাটাগরি)</p>
                <ul className="space-y-1">
                  {financeSummary.monthExpensesByCategory.slice(0, 6).map((e) => (
                    <li key={`${e.currency}-${e.category}`} className="text-cream">{e.display}</li>
                  ))}
                </ul>
              </div>
            )}
            <p className="mt-2 text-[9px] text-muted">সংশোধন শুধু চ্যাটে — এখানে শুধু দেখা</p>
          </div>
        )}

        {loading && <p className="py-6 text-center text-[11px] text-muted">লোড হচ্ছে…</p>}
        {!loading && memories.length === 0 && (
          <p className="py-8 text-center text-[11px] text-muted">কোনো স্মৃতি নেই</p>
        )}
        {memories.map((m) => (
          <div
            key={m.id}
            className={cn(
              'rounded-xl border p-3 text-[11px] transition-all',
              m.pinned
                ? 'border-[#E07A5F]/20 bg-[#E07A5F]/[0.04] shadow-sm'
                : 'border-border-subtle bg-white/[0.04]',
              m.scope === 'personal' && !m.pinned && 'shadow-sm',
              m.scope === 'business' && !m.pinned && 'shadow-sm',
              m.scope === 'staff' && !m.pinned && 'shadow-sm',
            )}
          >
            <div className="mb-1.5 flex items-center gap-2">
              <span className={cn('rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                m.scope === 'personal' ? 'tone-blue' :
                m.scope === 'business' ? 'tone-amber' :
                'tone-purple'
              )}>
                {SCOPE_LABELS[m.scope] ?? m.scope}
              </span>
              {m.key && <span className="text-muted">{m.key}</span>}
              <div className="ml-auto flex items-center gap-1">
                <button
                  onClick={() => togglePin(m.id, m.pinned)}
                  title={m.pinned ? 'পিন সরান' : 'পিন করুন'}
                  className={cn('rounded p-0.5 transition-colors', m.pinned ? 'text-[#E07A5F]' : 'text-muted hover:text-[#E07A5F]')}
                >
                  📌
                </button>
                <button
                  onClick={() => setDeleteMemId(m.id)}
                  className="rounded p-0.5 text-muted hover:text-red-500 transition-colors"
                  title="মুছুন"
                >
                  🗑️
                </button>
              </div>
            </div>
            <p className="leading-relaxed text-cream line-clamp-3">{m.content}</p>
            <p className="mt-1.5 text-[9px] text-muted">
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
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
            onClick={() => setDeleteMemId(null)}
          >
            <motion.div
              initial={{ scale: 0.95 }} animate={{ scale: 1 }} exit={{ scale: 0.95 }}
              className="w-full max-w-sm rounded-2xl border border-border bg-card/80 shadow-xl p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="mb-2 font-bold text-cream">স্মৃতি মুছবেন?</h3>
              <p className="mb-5 text-sm text-muted">এই তথ্য স্থায়ীভাবে মুছে যাবে।</p>
              <div className="flex gap-3">
                <button onClick={() => setDeleteMemId(null)} className="flex-1 rounded-xl border border-border-subtle bg-white/[0.04] py-2.5 text-sm text-muted-hi hover:text-cream">বাতিল</button>
                <button onClick={() => deleteMem(deleteMemId)} className="flex-1 rounded-xl tone-red border py-2.5 text-sm font-semibold hover:bg-red-500/20">মুছুন</button>
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
  const [businessId, setBusinessId] = useState<string>(project?.businessId ?? '')
  const [saving, setSaving] = useState(false)

  async function save() {
    if (!name.trim()) return
    setSaving(true)
    try {
      const payload = {
        name,
        description,
        systemInstructions: sysInstructions,
        businessId: businessId === '' ? null : businessId,
      }
      if (project) {
        await fetch(`/api/assistant/projects/${project.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } else {
        await fetch('/api/assistant/projects', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.95 }}
        animate={{ scale: 1 }}
        exit={{ scale: 0.95 }}
        className="w-full max-w-md rounded-2xl border border-border bg-card/80 shadow-xl p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-5 font-bold text-cream">{project ? 'প্রজেক্ট সম্পাদনা' : 'নতুন প্রজেক্ট'}</h3>
        <div className="space-y-4">
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">নাম *</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="ALMA Trading"
              className="w-full rounded-xl bg-white/[0.04] border border-border-subtle px-4 py-3 text-sm text-cream placeholder-gray-400 focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">বিবরণ</label>
            <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="সংক্ষিপ্ত বিবরণ"
              className="w-full rounded-xl bg-white/[0.04] border border-border-subtle px-4 py-3 text-sm text-cream placeholder-gray-400 focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">ব্যবসা (business scope)</label>
            <select
              value={businessId}
              onChange={(e) => setBusinessId(e.target.value)}
              className="w-full rounded-xl bg-white/[0.04] border border-border-subtle px-4 py-3 text-sm text-cream focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20"
            >
              <option value="">— Personal / cross-business —</option>
              <option value="ALMA_LIFESTYLE">ALMA Lifestyle</option>
              <option value="ALMA_TRADING">ALMA Trading (Binance P2P)</option>
            </select>
            <p className="mt-1 text-[11px] text-muted">
              Trading select করলে agent শুধু trading tools, staff, ও memory ব্যবহার করবে।
            </p>
          </div>
          <div>
            <label className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-muted">সিস্টেম নির্দেশনা</label>
            <textarea value={sysInstructions} onChange={(e) => setSysInstructions(e.target.value)}
              placeholder="এই প্রজেক্টের জন্য বিশেষ নির্দেশনা…"
              rows={4}
              className="w-full resize-none rounded-xl bg-white/[0.04] border border-border-subtle px-4 py-3 text-sm text-cream placeholder-gray-400 focus:outline-none focus:border-[#E07A5F]/30 focus:ring-1 focus:ring-[#E07A5F]/20"
            />
          </div>
        </div>
        <div className="mt-5 flex gap-3">
          <button onClick={onClose} className="flex-1 rounded-xl border border-border-subtle bg-white/[0.04] py-2.5 text-sm text-muted-hi hover:text-cream">বাতিল</button>
          <button onClick={save} disabled={!name.trim() || saving}
            className="flex-1 rounded-xl bg-[#E07A5F]/10 border border-[#E07A5F]/25 py-2.5 text-sm font-semibold text-[#E07A5F] hover:bg-[#E07A5F]/15 disabled:opacity-40"
          >
            {saving ? '…' : 'সংরক্ষণ'}
          </button>
        </div>
      </motion.div>
    </motion.div>
  )
}
