'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'
import { cn } from '@/lib/utils'

export interface PendingFile {
  file: File
  previewUrl: string
}

interface AgentComposerProps {
  onSend: (text: string, files: PendingFile[]) => void
  disabled: boolean
  onStop: () => void
  streaming: boolean
  conversationId: string | null
  isMobile?: boolean
}

export default function AgentComposer({
  onSend,
  disabled,
  onStop,
  streaming,
  conversationId: _conversationId,
  isMobile = false,
}: AgentComposerProps) {
  const [text, setText] = useState('')
  const [files, setFiles] = useState<PendingFile[]>([])
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, isMobile ? 120 : 160)}px`
  }, [text, isMobile])

  const send = useCallback(() => {
    if ((!text.trim() && files.length === 0) || disabled || streaming) return
    onSend(text, files)
    setText('')
    setFiles([])
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl))
  }, [text, files, disabled, streaming, onSend])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      send()
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = Array.from(e.target.files ?? [])
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
    const MAX = 10 * 1024 * 1024

    for (const f of selected) {
      if (!allowed.includes(f.type)) {
        toast.error(`অনুমোদিত নয়: ${f.name}`)
        continue
      }
      if (f.size > MAX) {
        toast.error(`খুব বড় (max 10MB): ${f.name}`)
        continue
      }
      setFiles((prev) => [...prev, { file: f, previewUrl: URL.createObjectURL(f) }])
    }
    e.target.value = ''
  }

  function removeFile(idx: number) {
    setFiles((prev) => {
      URL.revokeObjectURL(prev[idx].previewUrl)
      return prev.filter((_, i) => i !== idx)
    })
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mr = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' })
      mediaRecorderRef.current = mr
      const chunks: Blob[] = []
      mr.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop())
        clearInterval(recordTimerRef.current!)
        setRecording(false)
        setRecordSecs(0)
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const fd = new FormData()
        fd.append('audio', blob, 'recording.webm')
        const toastId = toast.loading('ট্রান্সক্রাইব হচ্ছে…')
        try {
          const res = await fetch('/api/assistant/transcribe', { method: 'POST', body: fd })
          const data = await res.json() as { text?: string; error?: string }
          toast.dismiss(toastId)
          if (res.ok && data.text) {
            setText((prev) => (prev ? `${prev} ${data.text}` : data.text!).trim())
          } else {
            toast.error(data.error ?? 'ট্রান্সক্রিপশন ব্যর্থ হয়েছে।')
          }
        } catch {
          toast.dismiss(toastId)
          toast.error('ট্রান্সক্রিপশন ব্যর্থ হয়েছে।')
        }
      }
      mr.start()
      setRecording(true)
      setRecordSecs(0)
      recordTimerRef.current = setInterval(() => setRecordSecs((s) => s + 1), 1000)
    } catch {
      toast.error('মাইক্রোফোন ব্যবহার করা যাচ্ছে না')
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop()
  }

  function cancelRecording() {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current)
    mediaRecorderRef.current?.stream.getTracks().forEach((t) => t.stop())
    mediaRecorderRef.current = null
    setRecording(false)
    setRecordSecs(0)
  }

  const canSend = (text.trim().length > 0 || files.length > 0) && !disabled && !streaming

  return (
    <div className="safe-x shrink-0 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-5 md:pb-5">
      {/* File preview strip */}
      {files.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <div key={i} className="relative shrink-0">
              {f.file.type.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl} alt="" className="h-14 w-14 rounded-xl border border-white/[0.06] object-cover" />
              ) : (
                <div className="flex h-14 w-14 flex-col items-center justify-center rounded-xl border border-white/[0.06] bg-white/[0.03] text-[10px] text-white/50">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                  <span className="mt-0.5">PDF</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-white/10 text-[8px] text-white/70 backdrop-blur-md hover:bg-red-500/80 hover:text-white"
              >
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Recording UI */}
      {recording && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl border border-red-400/15 bg-red-500/[0.04] px-4 py-2.5">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
          <span className="flex-1 text-sm font-medium text-red-300/80">
            রেকর্ডিং {Math.floor(recordSecs / 60).toString().padStart(2, '0')}:{(recordSecs % 60).toString().padStart(2, '0')}
          </span>
          <button type="button" onClick={cancelRecording} className="text-xs text-white/40 hover:text-white/70">বাতিল</button>
          <button type="button" onClick={stopRecording} className="rounded-lg bg-red-400/10 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-400/20">পাঠান</button>
        </div>
      )}

      {/* Input area */}
      <div
        className={cn(
          'flex items-end gap-1 rounded-2xl border p-1.5 transition-all duration-200 md:p-2',
          streaming
            ? 'border-gold/20 bg-[rgba(15,15,20,0.7)] shadow-[0_0_20px_rgba(201,168,76,0.06)]'
            : 'border-white/[0.08] bg-[rgba(15,15,20,0.5)] focus-within:border-white/[0.14] focus-within:bg-[rgba(15,15,20,0.7)]',
        )}
      >
        {/* Attach */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || streaming}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white/30 transition-all hover:bg-white/[0.05] hover:text-white/60 disabled:opacity-30 md:h-9 md:w-9"
          aria-label="ফাইল যুক্ত করুন"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="hidden" onChange={handleFileChange} />

        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || recording || streaming}
          placeholder={recording ? '' : 'বার্তা লিখুন…'}
          rows={1}
          className="max-h-[120px] min-h-[44px] flex-1 resize-none bg-transparent px-1.5 py-2.5 text-[15px] leading-snug text-white/90 placeholder-white/25 focus:outline-none disabled:opacity-40 md:min-h-[40px] md:text-sm"
        />

        {/* Mic */}
        {!recording && !streaming && (
          <button
            type="button"
            onClick={startRecording}
            disabled={disabled}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white/30 transition-all hover:bg-white/[0.05] hover:text-white/60 disabled:opacity-30 md:h-9 md:w-9"
            aria-label="ভয়েস ইনপুট"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="1" width="6" height="11" rx="3"/><path d="M19 10v2a7 7 0 01-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
          </button>
        )}

        {/* Send / Stop */}
        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/[0.08] text-white/60 transition-all hover:bg-white/[0.12] active:scale-95 md:h-9 md:w-9"
            aria-label="থামান"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-all active:scale-95 md:h-9 md:w-9',
              canSend
                ? 'bg-white text-black hover:bg-white/90'
                : 'bg-white/[0.06] text-white/20',
            )}
            aria-label="পাঠান"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
          </button>
        )}
      </div>
    </div>
  )
}
