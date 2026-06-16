'use client'

import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import DemoMarkdown from './DemoMarkdown'
import DemoEmptyState from './DemoEmptyState'
import type { DemoMessage, DemoDelegation, DemoTool } from './mock-data'

interface DemoThreadProps {
  messages: DemoMessage[]
  streaming: boolean
  streamLabel: string | null
  onSuggestion: (text: string) => void
}

function ThoughtBlock({ thinking, seconds, live }: { thinking: string; seconds?: number; live: boolean }) {
  const [open, setOpen] = useState(live)
  useEffect(() => setOpen(live), [live])
  const label = live ? 'ভাবছি…' : seconds != null ? `Thought for ${seconds}s` : 'চিন্তা'

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[12px] font-medium text-[#94a3b8] transition-colors hover:text-[#64748b]"
      >
        {live ? (
          <motion.span
            className="inline-block h-3 w-3 rounded-full border-[1.5px] border-[#E07A5F]/40 border-t-[#E07A5F]"
            animate={{ rotate: 360 }}
            transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
            aria-hidden
          />
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 2a7 7 0 00-4 12.74V17a2 2 0 002 2h4a2 2 0 002-2v-2.26A7 7 0 0012 2z" />
            <path d="M9 21h6" />
          </svg>
        )}
        <span>{label}</span>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden>
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="mt-2 border-l-2 border-black/[0.07] pl-3 text-[13px] leading-relaxed text-[#64748b]">
              {thinking}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function ToolChip({ tool }: { tool: DemoTool }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-all ${
        tool.done
          ? tool.success !== false
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-red-200 bg-red-50 text-red-600'
          : 'border-black/[0.08] bg-black/[0.02] text-gray-500'
      }`}
    >
      <span className="text-[12px] leading-none">{tool.icon}</span>
      {tool.done && tool.success !== false && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M20 6L9 17l-5-5" /></svg>
      )}
      <span>{tool.label}</span>
    </span>
  )
}

function DelegationCard({ d }: { d: DemoDelegation }) {
  const [open, setOpen] = useState(false)
  const hasSummary = Boolean(d.summary)
  return (
    <div className="overflow-hidden rounded-2xl border border-black/[0.07] bg-white/70 backdrop-blur-sm">
      <button
        type="button"
        onClick={() => hasSummary && setOpen((o) => !o)}
        className={`flex w-full items-start gap-2.5 px-3 py-2.5 text-left ${hasSummary ? 'cursor-pointer hover:bg-black/[0.02]' : 'cursor-default'}`}
      >
        <span className="mt-0.5 text-[15px] leading-none">{d.icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] font-semibold text-[#1a1a2e]">{d.roleLabel}</span>
            <span className="rounded-md bg-[#E07A5F]/[0.08] px-1.5 py-0.5 text-[10px] font-medium text-[#E07A5F]">সাব-এজেন্ট</span>
          </span>
          <span className="mt-0.5 block text-[12px] leading-snug text-[#64748b]">{d.task}</span>
        </span>
        <span className="mt-0.5 shrink-0">
          {d.success !== false ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M20 6L9 17l-5-5" /></svg>
          ) : (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12" /></svg>
          )}
        </span>
      </button>
      <AnimatePresence initial={false}>
        {open && hasSummary && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }} className="overflow-hidden">
            <div className="border-t border-black/[0.06] px-3 py-2.5 text-[13px] leading-relaxed text-[#334155]">{d.summary}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

function MessageMeta({ msg }: { msg: DemoMessage }) {
  if (msg.tokensIn == null) return null
  return (
    <div className="mt-2 flex items-center gap-3 text-[11px] text-gray-400">
      <span>↑ {msg.tokensIn?.toLocaleString()}</span>
      <span>↓ {msg.tokensOut?.toLocaleString()}</span>
      {msg.costUsd != null && <span className="text-[#E07A5F]/70">${msg.costUsd.toFixed(4)}</span>}
    </div>
  )
}

export default function DemoThread({ messages, streaming, streamLabel, onSuggestion }: DemoThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages, streaming])

  return (
    <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-y-contain">
      <div className="mx-auto max-w-2xl px-4 py-6 pb-10 md:px-6">
        {messages.length === 0 && <DemoEmptyState onSuggestion={onSuggestion} />}

        <AnimatePresence initial={false}>
          {messages.map((msg, index) => (
            <motion.div
              key={msg.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, delay: index < 8 ? index * 0.02 : 0 }}
              className={msg.role === 'user' ? 'mb-6' : 'mb-8'}
            >
              {msg.role === 'user' ? (
                <div className="flex justify-end">
                  <div className="min-w-0 max-w-[85%]">
                    {msg.files && msg.files.length > 0 && (
                      <div className="mb-2 flex flex-wrap justify-end gap-2">
                        {msg.files.map((f, i) => (
                          <div key={i} className="flex h-14 w-14 flex-col items-center justify-center rounded-2xl border border-black/[0.06] bg-gray-50 text-[10px] text-gray-500">
                            {f.kind === 'pdf' ? 'PDF' : 'IMG'}
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="rounded-2xl rounded-br-sm bg-[#E07A5F]/10 px-4 py-3 text-[15px] leading-relaxed text-[#1a1a2e]">
                      {msg.text}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="min-w-0">
                  {msg.thinking && <ThoughtBlock thinking={msg.thinking} seconds={msg.thinkingSeconds} live={false} />}

                  {msg.tools && msg.tools.length > 0 && (
                    <div className="mb-3 flex flex-wrap gap-1.5">
                      {msg.tools.map((t) => (
                        <ToolChip key={t.name} tool={t} />
                      ))}
                    </div>
                  )}

                  {msg.delegations && msg.delegations.length > 0 && (
                    <div className="mb-3 flex flex-col gap-2">
                      {msg.delegations.map((d) => (
                        <DelegationCard key={d.id} d={d} />
                      ))}
                    </div>
                  )}

                  <DemoMarkdown content={msg.text} />
                  <MessageMeta msg={msg} />
                </div>
              )}
            </motion.div>
          ))}
        </AnimatePresence>

        {/* Live streaming indicator */}
        <AnimatePresence>
          {streaming && streamLabel && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-8 flex items-center gap-2 text-[13px] font-medium text-[#64748b]"
            >
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="h-1.5 w-1.5 rounded-full bg-[#E07A5F]"
                    animate={{ opacity: [0.3, 1, 0.3], y: [0, -2, 0] }}
                    transition={{ duration: 1, repeat: Infinity, delay: i * 0.15 }}
                  />
                ))}
              </span>
              {streamLabel}
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={bottomRef} />
      </div>
    </div>
  )
}
