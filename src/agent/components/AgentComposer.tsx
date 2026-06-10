'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import toast from 'react-hot-toast'

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
}

export default function AgentComposer({
  onSend,
  disabled,
  onStop,
  streaming,
  conversationId,
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
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const send = useCallback(() => {
    if ((!text.trim() && files.length === 0) || disabled || streaming) return
    onSend(text, files)
    setText('')
    setFiles([])
    files.forEach((f) => URL.revokeObjectURL(f.previewUrl))
  }, [text, files, disabled, streaming, onSend])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Mobile: always show send button (never Enter=send on mobile)
    // Desktop: Enter=send, Shift+Enter=newline
    if (e.key === 'Enter' && !e.shiftKey) {
      const isMobileLike = window.innerWidth < 640
      if (!isMobileLike) {
        e.preventDefault()
        send()
      }
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
    // Reset input so same file can be re-selected
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
        // Send to stub endpoint
        const blob = new Blob(chunks, { type: 'audio/webm' })
        const fd = new FormData()
        fd.append('audio', blob, 'recording.webm')
        const res = await fetch('/api/assistant/transcribe', { method: 'POST', body: fd })
        if (res.status === 501) {
          toast('🎤 Phase 3-এ চালু হবে', { icon: 'ℹ️' })
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
    <div className="border-t border-border bg-surface px-3 pb-3 pt-2 sm:px-4 sm:pb-4">
      {/* File preview strip */}
      {files.length > 0 && (
        <div className="mb-2 flex gap-2 overflow-x-auto pb-1">
          {files.map((f, i) => (
            <div key={i} className="relative flex-shrink-0">
              {f.file.type.startsWith('image/') ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={f.previewUrl} alt="" className="h-16 w-16 rounded-xl object-cover border border-border" />
              ) : (
                <div className="flex h-16 w-16 flex-col items-center justify-center rounded-xl border border-border bg-card text-[10px] text-muted-hi">
                  <span className="text-xl">📄</span>
                  <span className="truncate px-1 text-center">PDF</span>
                </div>
              )}
              <button
                onClick={() => removeFile(i)}
                className="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-red-500 text-[10px] text-white shadow"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Recording indicator */}
      {recording && (
        <div className="mb-2 flex items-center gap-3 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5">
          <span className="h-2 w-2 rounded-full bg-red-400 animate-pulse" />
          <span className="flex-1 text-sm font-semibold text-red-400">
            রেকর্ডিং {Math.floor(recordSecs / 60).toString().padStart(2, '0')}:{(recordSecs % 60).toString().padStart(2, '0')}
          </span>
          <button onClick={cancelRecording} className="text-xs text-muted-hi hover:text-cream">বাতিল</button>
          <button onClick={stopRecording} className="rounded-lg bg-red-400/20 px-3 py-1 text-xs font-semibold text-red-400">বন্ধ করুন</button>
        </div>
      )}

      <div className="flex items-end gap-2">
        {/* File attach */}
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
          className="flex-shrink-0 rounded-xl border border-border p-2.5 text-muted-hi transition-colors hover:border-gold-dim/30 hover:text-cream disabled:opacity-40"
          title="ফাইল যুক্ত করুন"
        >
          📎
        </button>
        <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" multiple className="hidden" onChange={handleFileChange} />

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={disabled || recording}
          placeholder={recording ? '' : 'বার্তা লিখুন…'}
          rows={1}
          className="flex-1 resize-none rounded-xl border border-border bg-card px-4 py-3 text-sm text-cream placeholder-zinc-600 focus:outline-none focus:border-gold-dim/60 transition-colors disabled:opacity-50 min-h-[46px]"
          style={{ fontFamily: 'var(--font-sans)' }}
        />

        {/* Mic button */}
        {!recording && !streaming && (
          <button
            onClick={startRecording}
            disabled={disabled}
            className="flex-shrink-0 rounded-xl border border-border p-2.5 text-muted-hi transition-colors hover:border-gold-dim/30 hover:text-cream disabled:opacity-40"
            title="ভয়েস ইনপুট"
          >
            🎤
          </button>
        )}

        {/* Stop / Send button */}
        {streaming ? (
          <button
            onClick={onStop}
            className="flex-shrink-0 rounded-xl border border-red-400/30 bg-red-400/10 px-4 py-2.5 text-sm font-semibold text-red-400 hover:bg-red-400/20 transition-colors"
          >
            ⏹ থামান
          </button>
        ) : (
          <button
            onClick={send}
            disabled={!canSend}
            className="flex-shrink-0 rounded-xl bg-gold/10 border border-gold-dim/40 px-4 py-2.5 text-sm font-semibold text-gold-lt hover:bg-gold/20 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            পাঠান
          </button>
        )}
      </div>
    </div>
  )
}
