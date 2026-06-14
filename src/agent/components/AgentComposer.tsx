'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'
import { cn } from '@/lib/utils'

export interface PendingFile {
  file: File
  previewUrl: string // object URL for image thumbnails
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

  // Auto-grow textarea
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
    <div className="safe-x shrink-0 border-t border-white/[0.06] bg-gradient-to-t from-black via-black/95 to-black/80 px-3 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 md:px-4 md:pb-4 md:pt-3">
      {files.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <div key={i} className="relative shrink-0">
              {f.file.type.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl} alt="" className="h-16 w-16 rounded-xl border border-white/[0.08] object-cover" />
              ) : (
                <div className="flex h-16 w-16 flex-col items-center justify-center rounded-xl border border-white/[0.08] bg-card text-[10px] text-muted-hi">
                  <span className="text-xl">📄</span>
                  <span className="truncate px-1 text-center">PDF</span>
                </div>
              )}
              <button
                type="button"
                onClick={() => removeFile(i)}
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white shadow"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}


      {recording && (
        <div className="mb-2 flex items-center gap-3 rounded-2xl border border-red-400/30 bg-red-400/10 px-4 py-2.5">
          <span className="h-2 w-2 animate-pulse rounded-full bg-red-400" />
          <span className="flex-1 text-sm font-semibold text-red-400">
            রেকর্ডিং {Math.floor(recordSecs / 60).toString().padStart(2, '0')}:{(recordSecs % 60).toString().padStart(2, '0')}
          </span>
          <button type="button" onClick={cancelRecording} className="text-xs text-muted-hi hover:text-cream">বাতিল</button>
          <button type="button" onClick={stopRecording} className="rounded-lg bg-red-400/20 px-3 py-1 text-xs font-semibold text-red-400">বন্ধ</button>
        </div>
      )}

      <div
        className={cn(
          'flex items-end gap-1.5 rounded-[1.35rem] border border-white/[0.1] bg-zinc-900/90 p-1.5 shadow-[0_8px_32px_rgba(0,0,0,0.45)] backdrop-blur-xl md:gap-2 md:p-2',
          streaming && 'border-gold-dim/25',
        )}
      >
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || streaming}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base text-muted-hi transition-colors hover:bg-white/[0.05] hover:text-cream disabled:opacity-40 md:h-9 md:w-9"
          title="ফাইল যুক্ত করুন"
          aria-label="ফাইল যুক্ত করুন"
        >
          📎
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
          className="max-h-[120px] min-h-[44px] flex-1 resize-none bg-transparent px-1 py-2.5 text-[15px] leading-snug text-cream placeholder-zinc-600 focus:outline-none disabled:opacity-50 md:min-h-[40px] md:text-sm"
          style={{ fontFamily: 'var(--font-sans)' }}
        />

        {!recording && !streaming && (
          <button
            type="button"
            onClick={startRecording}
            disabled={disabled}
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-base text-muted-hi transition-colors hover:bg-white/[0.05] hover:text-cream disabled:opacity-40 md:h-9 md:w-9"
            title="ভয়েস ইনপুট"
            aria-label="ভয়েস ইনপুট"
          >
            🎤
          </button>
        )}

        {streaming ? (
          <button
            type="button"
            onClick={onStop}
            className="flex h-10 shrink-0 items-center justify-center rounded-xl bg-red-500/15 px-3 text-xs font-semibold text-red-400 transition-colors hover:bg-red-500/25 md:h-9"
          >
            ⏹
          </button>
        ) : (
          <button
            type="button"
            onClick={send}
            disabled={!canSend}
            className={cn(
              'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-sm font-bold transition-all md:h-9 md:w-9',
              canSend
                ? 'bg-gold/20 text-gold-lt hover:bg-gold/30 active:scale-95'
                : 'bg-white/[0.04] text-zinc-600',
            )}
            aria-label="পাঠান"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
