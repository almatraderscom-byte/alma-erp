'use client'

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { DEMO_PROJECTS, type DemoConversation } from './mock-data'

interface DemoSidebarProps {
  open: boolean
  isMobile: boolean
  onClose: () => void
  conversations: DemoConversation[]
  activeId: string | null
  onSelect: (c: DemoConversation) => void
  onNew: () => void
  personalActive: boolean
  onPersonal: () => void
}

const PROJECT_ALL = '__all__'

function badgeClasses(tone: 'trading' | 'lifestyle') {
  return tone === 'trading'
    ? 'bg-amber-100 text-amber-700 border-amber-200'
    : 'bg-emerald-100 text-emerald-700 border-emerald-200'
}

function SidebarBody({
  conversations,
  activeId,
  onSelect,
  onNew,
  personalActive,
  onPersonal,
  isMobile,
  onClose,
}: Omit<DemoSidebarProps, 'open'>) {
  const [tab, setTab] = useState<'chats' | 'memory'>('chats')
  const [project, setProject] = useState(PROJECT_ALL)
  const [search, setSearch] = useState('')

  const filtered = conversations.filter((c) => {
    if (project !== PROJECT_ALL && c.projectId !== project) return false
    if (search && !c.title.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  return (
    <div className="flex h-full flex-col bg-white/90 backdrop-blur-2xl">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-[#E8B4A0] to-[#E07A5F] text-[13px] font-bold text-white shadow-sm">A</span>
          <span className="text-sm font-bold text-[#E07A5F]">ALMA Agent</span>
        </div>
        {isMobile && (
          <button onClick={onClose} className="rounded-lg p-1.5 text-gray-400 hover:text-gray-600" aria-label="বন্ধ করুন">✕</button>
        )}
      </div>

      {/* Personal mode */}
      <div className="border-b border-black/[0.06] px-3 py-2">
        <button
          type="button"
          onClick={onPersonal}
          className={`w-full rounded-xl border px-3 py-2.5 text-left text-xs font-semibold transition-all ${
            personalActive
              ? 'border-emerald-300 bg-emerald-50 text-emerald-700 shadow-sm'
              : 'border-black/[0.06] bg-gray-50 text-gray-700 hover:border-emerald-200 hover:bg-emerald-50/50'
          }`}
        >
          🤲 ব্যক্তিগত
          {personalActive && <span className="mt-0.5 block text-[10px] font-normal text-emerald-600">মোড সক্রিয়</span>}
        </button>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-black/[0.06]">
        {(['chats', 'memory'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2.5 text-xs font-semibold transition-all ${
              tab === t ? 'border-b-2 border-[#E07A5F] text-[#E07A5F]' : 'text-gray-400 hover:bg-black/[0.02] hover:text-gray-600'
            }`}
          >
            {t === 'chats' ? '💬 চ্যাট' : '🧠 স্মৃতি'}
          </button>
        ))}
      </div>

      {tab === 'memory' ? (
        <MemoryView />
      ) : (
        <>
          {/* Project + new */}
          <div className="border-b border-black/[0.06] p-3">
            <select
              value={project}
              onChange={(e) => setProject(e.target.value)}
              className="w-full rounded-xl border border-black/[0.06] bg-gray-50 px-3 py-2 text-xs text-gray-700 focus:border-[#E07A5F]/30 focus:outline-none focus:ring-1 focus:ring-[#E07A5F]/20"
            >
              <option value={PROJECT_ALL}>সব কথোপকথন</option>
              {DEMO_PROJECTS.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button
              onClick={onNew}
              className="mt-2 w-full rounded-xl border border-[#E07A5F]/25 bg-[#E07A5F]/10 px-3 py-2 text-xs font-semibold text-[#E07A5F] transition-all hover:bg-[#E07A5F]/15 hover:shadow-sm"
            >
              + নতুন চ্যাট
            </button>
          </div>

          {/* Search */}
          <div className="px-3 pt-3">
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="খুঁজুন…"
              className="w-full rounded-xl border border-black/[0.06] bg-gray-50 px-3 py-2 text-xs text-gray-700 placeholder-gray-400 focus:border-[#E07A5F]/30 focus:outline-none focus:ring-1 focus:ring-[#E07A5F]/20"
            />
          </div>

          {/* List */}
          <div className="flex-1 space-y-1 overflow-y-auto p-3">
            {filtered.length === 0 && (
              <p className="py-8 text-center text-[11px] text-gray-400">কোনো কথোপকথন নেই</p>
            )}
            {filtered.map((c) => {
              const proj = DEMO_PROJECTS.find((p) => p.id === c.projectId)
              return (
                <button
                  key={c.id}
                  onClick={() => onSelect(c)}
                  className={`group relative w-full rounded-xl px-3 py-2.5 text-left transition-all ${
                    c.id === activeId
                      ? 'border border-[#E07A5F]/20 bg-[#E07A5F]/[0.08] shadow-sm'
                      : 'border border-transparent hover:bg-black/[0.02]'
                  }`}
                >
                  <div className="flex items-center gap-1.5">
                    {c.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-500" />}
                    <p className={`truncate text-xs font-medium ${c.id === activeId ? 'text-[#E07A5F]' : 'text-gray-700 group-hover:text-gray-900'}`}>
                      {c.title}
                    </p>
                  </div>
                  <p className="mt-0.5 truncate text-[10px] text-gray-400">{c.preview}</p>
                  <div className="mt-1 flex items-center gap-1.5">
                    <span className="text-[10px] text-gray-400">{c.dateLabel}</span>
                    {proj?.badge && (
                      <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${badgeClasses(proj.badge.tone)}`}>
                        {proj.badge.label}
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

function MemoryView() {
  const rules = [
    { domain: 'অর্ডার', text: 'অর্ডার সারাংশে সবসময় মোট বিক্রির অঙ্ক দেখাও', count: 12 },
    { domain: 'স্টক', text: 'reorder threshold-এর নিচে নামলেই সতর্ক করো', count: 8 },
    { domain: 'টোন', text: 'কাস্টমার পোস্ট বাংলায়, উষ্ণ ও সম্মানজনক ভাষায়', count: 21 },
    { domain: 'ফাইন্যান্স', text: 'পেমেন্ট due তারিখ অনুযায়ী সাজিয়ে দেখাও', count: 5 },
  ]
  return (
    <div className="flex-1 overflow-y-auto p-3">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-[#E07A5F]">শেখা নিয়ম</p>
      <div className="space-y-1.5">
        {rules.map((r, i) => (
          <div key={i} className="rounded-xl border border-black/[0.05] bg-gray-50 px-3 py-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-medium text-[#81B29A]">{r.domain}</span>
              <span className="text-[10px] text-gray-400">{r.count}× প্রয়োগ</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-gray-700">{r.text}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function DemoSidebar(props: DemoSidebarProps) {
  const { open, isMobile, onClose } = props

  if (isMobile) {
    return (
      <AnimatePresence>
        {open && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" onClick={onClose} />
            <motion.div
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', damping: 28, stiffness: 280 }}
              className="fixed inset-y-0 left-0 z-50 w-72"
            >
              <SidebarBody {...props} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
    )
  }

  return (
    <div className={`shrink-0 border-r border-black/[0.06] transition-all duration-200 ${open ? 'w-72' : 'w-0 overflow-hidden'}`}>
      {open && <SidebarBody {...props} />}
    </div>
  )
}
