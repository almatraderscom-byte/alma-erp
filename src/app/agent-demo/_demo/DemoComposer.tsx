'use client'

import { useState, useRef, useCallback, useEffect } from 'react'

interface DemoComposerProps {
  onSend: (text: string) => void
  streaming: boolean
  onStop: () => void
}

const MODELS = ['Claude Sonnet 4.6', 'Claude Haiku', 'GPT-5 mini']

export default function DemoComposer({ onSend, streaming, onStop }: DemoComposerProps) {
  const [text, setText] = useState('')
  const [model, setModel] = useState(MODELS[0])
  const [modelOpen, setModelOpen] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const send = useCallback(() => {
    if (!text.trim() || streaming) return
    onSend(text)
    setText('')
  }, [text, streaming, onSend])

  const canSend = text.trim().length > 0 && !streaming

  return (
    <div className="shrink-0 px-3 pb-4 pt-2 md:px-5 md:pb-5">
      <div className="mx-auto max-w-2xl">
        <div
          className={`flex flex-col gap-1 rounded-[20px] border p-2 shadow-sm transition-all duration-200 ${
            streaming
              ? 'border-[#E07A5F]/25 bg-white shadow-[0_4px_20px_rgba(224,122,95,0.10)]'
              : 'border-black/[0.08] bg-white focus-within:border-[#E07A5F]/30 focus-within:shadow-[0_4px_20px_rgba(224,122,95,0.08)]'
          }`}
        >
          <div className="flex items-end gap-1">
            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-black/[0.04] hover:text-gray-600"
              aria-label="ফাইল যুক্ত করুন"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" /></svg>
            </button>

            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder="বার্তা লিখুন…"
              rows={1}
              className="max-h-[160px] min-h-[40px] flex-1 resize-none bg-transparent px-1.5 py-2.5 text-[15px] leading-snug text-[#1a1a2e] placeholder-gray-400 focus:outline-none"
            />

            <button
              type="button"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-gray-400 transition-all hover:bg-[#E07A5F]/[0.08] hover:text-[#E07A5F]"
              aria-label="ভয়েস"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="9" y="1" width="6" height="11" rx="3" /><path d="M19 10v2a7 7 0 01-14 0v-2" /><line x1="12" y1="19" x2="12" y2="23" /><line x1="8" y1="23" x2="16" y2="23" /></svg>
            </button>

            {streaming ? (
              <button type="button" onClick={onStop} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gray-100 text-gray-600 transition-colors hover:bg-gray-200" aria-label="থামান">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
              </button>
            ) : (
              <button
                type="button"
                onClick={send}
                disabled={!canSend}
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all ${
                  canSend ? 'bg-[#E07A5F] text-white shadow-sm hover:bg-[#D4694E] active:scale-95' : 'bg-gray-100 text-gray-300'
                }`}
                aria-label="পাঠান"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
              </button>
            )}
          </div>

          {/* Model selector */}
          <div className="relative flex items-center border-t border-black/[0.04] px-1 pt-1.5">
            <button
              type="button"
              onClick={() => setModelOpen((o) => !o)}
              className="flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium text-gray-500 transition-colors hover:bg-black/[0.03] hover:text-gray-700"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-[#81B29A]" />
              {model}
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${modelOpen ? 'rotate-180' : ''}`}><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {modelOpen && (
              <div className="absolute bottom-9 left-1 z-20 w-48 overflow-hidden rounded-xl border border-black/[0.08] bg-white shadow-lg">
                {MODELS.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => { setModel(m); setModelOpen(false) }}
                    className={`flex w-full items-center gap-2 px-3 py-2.5 text-left text-[12px] transition-colors hover:bg-black/[0.03] ${m === model ? 'font-semibold text-[#E07A5F]' : 'text-gray-600'}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <p className="mt-2 text-center text-[10px] text-gray-400">
          এটি একটি ডিজাইন ডেমো — উত্তরগুলো পূর্বনির্ধারিত (mock data)
        </p>
      </div>
    </div>
  )
}
