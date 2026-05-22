'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import toast from 'react-hot-toast'
import { Button, Select, Spinner } from '@/components/ui'
import { ModalFrame } from '@/components/trading/TradingModals'
import { api } from '@/lib/api'
import { tradingDrafts } from '@/lib/trading-drafts'
import { optimizeTradingScreenshot } from '@/lib/trading-screenshot'
import {
  formatUploadUserError,
  isAcceptedTradingScreenshot,
  isHeicLike,
  isIosTradingDevice,
  isStandalonePwa,
  isTradingUploadDebugEnabled,
  logTradingUpload,
  readTradingUploadDebugLog,
  TRADING_SCREENSHOT_CAMERA_ACCEPT,
  TRADING_SCREENSHOT_GALLERY_ACCEPT,
  type ScreenshotPickSource,
} from '@/lib/trading-screenshot-picker'
import {
  fingerprintFile,
  isDuplicateClientUpload,
  markUploadCooldown,
  rememberFingerprint,
  uploadCooldownRemainingMs,
} from '@/lib/trading-upload-guard'
import type { TradingAccount, TradingPerformanceScreenshot } from '@/types/trading'

type UploadPhase = 'idle' | 'optimizing' | 'uploading' | 'success'

export function ScreenshotUploadModal({
  open,
  accounts,
  defaultAccountId,
  recentByAccount,
  onClose,
  onUploaded,
}: {
  open: boolean
  accounts: TradingAccount[]
  defaultAccountId?: string
  recentByAccount?: Record<string, TradingPerformanceScreenshot[]>
  onClose: () => void
  onUploaded?: (screenshot: TradingPerformanceScreenshot) => void
}) {
  const [accountId, setAccountId] = useState('')
  const [shotDate, setShotDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [note, setNote] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [pickSource, setPickSource] = useState<ScreenshotPickSource | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [previewBroken, setPreviewBroken] = useState(false)
  const [phase, setPhase] = useState<UploadPhase>('idle')
  const [dragOver, setDragOver] = useState(false)
  const [successShot, setSuccessShot] = useState<TradingPerformanceScreenshot | null>(null)
  const [userError, setUserError] = useState<string | null>(null)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [debugLines, setDebugLines] = useState<Array<Record<string, unknown>>>([])
  const submitLock = useRef(false)
  const formRef = useRef<HTMLFormElement>(null)
  const galleryRef = useRef<HTMLInputElement>(null)
  const cameraRef = useRef<HTMLInputElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const busy = phase === 'optimizing' || phase === 'uploading'

  const clearSelection = useCallback(() => {
    setFile(null)
    setPickSource(null)
    setPreviewBroken(false)
    setUploadProgress(0)
    if (galleryRef.current) galleryRef.current.value = ''
    if (cameraRef.current) cameraRef.current.value = ''
  }, [])

  useEffect(() => {
    if (!open) return
    const draft = tradingDrafts.screenshot.load()
    setAccountId(defaultAccountId || draft?.accountId || accounts[0]?.id || '')
    setShotDate(draft?.shotDate || new Date().toISOString().slice(0, 10))
    setNote(draft?.note || '')
    clearSelection()
    setPhase('idle')
    setSuccessShot(null)
    setUserError(null)
    setUploadProgress(0)
    submitLock.current = false
    abortRef.current?.abort()
    abortRef.current = null
    logTradingUpload('modal:open', {
      ios: isIosTradingDevice(),
      pwa: isStandalonePwa(),
      debug: isTradingUploadDebugEnabled(),
    })
  }, [accounts, clearSelection, defaultAccountId, open])

  useEffect(() => {
    if (!open) return
    const t = window.setTimeout(() => {
      if (phase === 'success') return
      tradingDrafts.screenshot.save({ accountId, shotDate, note, savedAt: new Date().toISOString() })
    }, 400)
    return () => window.clearTimeout(t)
  }, [accountId, note, open, phase, shotDate])

  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      setPreviewBroken(false)
      return
    }
    setPreviewBroken(false)
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    logTradingUpload('preview:object-url', { name: file.name, type: file.type || '(empty)', heic: isHeicLike(file) })
    return () => URL.revokeObjectURL(url)
  }, [file])

  useEffect(() => {
    if (!showDebugEnabled()) return
    setDebugLines(readTradingUploadDebugLog())
  }, [file, phase, userError, uploadProgress])

  function showDebugEnabled() {
    return isTradingUploadDebugEnabled()
  }

  const recent = useMemo(
    () => (accountId ? recentByAccount?.[accountId] ?? [] : []).slice(0, 4),
    [accountId, recentByAccount],
  )

  const cooldownMs = accountId ? uploadCooldownRemainingMs(accountId) : 0

  const pickFile = useCallback((next: File | null, source: ScreenshotPickSource) => {
    setUserError(null)
    if (!next) return

    logTradingUpload('file:selected', {
      source,
      name: next.name,
      type: next.type || '(empty)',
      size: next.size,
      lastModified: next.lastModified,
    })

    if (!isAcceptedTradingScreenshot(next, source)) {
      const msg = 'Unsupported file — choose a photo (JPEG, PNG, WebP, or HEIC).'
      setUserError(msg)
      toast.error(msg)
      return
    }

    setFile(next)
    setPickSource(source)
    setSuccessShot(null)
    setPhase('idle')
    toast.success(source === 'camera' ? 'Photo captured' : 'Photo selected', { duration: 2000 })
  }, [])

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>, source: ScreenshotPickSource) => {
      const chosen = e.target.files?.[0] ?? null
      e.target.value = ''
      pickFile(chosen, source)
    },
    [pickFile],
  )

  const cancelUpload = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    submitLock.current = false
    setPhase('idle')
    setUploadProgress(0)
    setUserError('Upload cancelled')
    logTradingUpload('upload:cancelled', {})
  }, [])

  const submit = useCallback(async () => {
    if (submitLock.current || busy) return
    if (!accountId) {
      toast.error('Select an account')
      return
    }
    if (!file) {
      toast.error('Choose or take a screenshot first')
      return
    }
    if (cooldownMs > 0) {
      const msg = `Wait ${Math.ceil(cooldownMs / 1000)}s before uploading again`
      toast.error(msg)
      setUserError(msg)
      return
    }

    submitLock.current = true
    setUserError(null)
    abortRef.current?.abort()
    const abort = new AbortController()
    abortRef.current = abort
    let succeeded = false

    try {
      const fingerprint = await fingerprintFile(file)
      if (isDuplicateClientUpload(accountId, shotDate, fingerprint)) {
        const msg = 'This image was already uploaded for this date'
        toast.error(msg)
        setUserError(msg)
        return
      }

      setPhase('optimizing')
      setUploadProgress(0)

      let optimized = file
      try {
        optimized = await optimizeTradingScreenshot(file)
      } catch (e) {
        const msg = formatUploadUserError(e)
        toast.error(msg)
        setUserError(msg)
        logTradingUpload('optimize:failed', { message: msg })
        return
      }

      if (abort.signal.aborted) return

      setPhase('uploading')
      logTradingUpload('upload:start', {
        accountId,
        shotDate,
        size: optimized.size,
        type: optimized.type || '(empty)',
      })

      const res = await api.trading.uploadPerformanceScreenshot(
        accountId,
        optimized,
        { shotDate, note: note.trim(), fingerprint },
        {
          signal: abort.signal,
          timeoutMs: 120_000,
          onProgress: pct => setUploadProgress(pct),
        },
      )

      if (!res?.screenshot) {
        const msg = 'Upload failed — no response from server'
        toast.error(msg)
        setUserError(msg)
        return
      }

      rememberFingerprint(accountId, shotDate, fingerprint)
      markUploadCooldown(accountId)
      tradingDrafts.screenshot.clear()
      setSuccessShot(res.screenshot)
      setPhase('success')
      setUploadProgress(100)
      succeeded = true
      onUploaded?.(res.screenshot)
      toast.success('Screenshot uploaded')
      logTradingUpload('upload:success', { screenshotId: res.screenshot.id })
    } catch (e) {
      if (abort.signal.aborted) return
      const msg = formatUploadUserError(e)
      toast.error(msg)
      setUserError(msg)
      logTradingUpload('upload:error', { message: msg })
    } finally {
      submitLock.current = false
      abortRef.current = null
      if (!succeeded) setPhase('idle')
    }
  }, [accountId, busy, cooldownMs, file, note, onUploaded, shotDate])

  const closeModal = () => {
    if (busy) return
    onClose()
  }

  const showDebug = isTradingUploadDebugEnabled()

  if (phase === 'success' && successShot) {
    return (
      <ModalFrame open={open} onClose={closeModal} title="Screenshot uploaded" desc="Saved and linked to the account">
        <SuccessContent successShot={successShot} accountId={accountId} accounts={accounts} onClose={closeModal} onAnother={() => {
          setPhase('idle')
          setSuccessShot(null)
          clearSelection()
        }} />
      </ModalFrame>
    )
  }

  return (
    <ModalFrame
      open={open}
      onClose={closeModal}
      title="Upload performance screenshot"
      desc="Binance profile / P2P proof · camera or gallery"
      footer={
        <div className="flex w-full flex-col gap-2">
          {file && !busy && userError ? (
            <Button variant="secondary" className="w-full min-h-[44px] justify-center" onClick={() => void submit()}>
              Retry upload
            </Button>
          ) : null}
          <Button
            type="button"
            variant="gold"
            className="w-full min-h-[48px] justify-center touch-manipulation"
            disabled={busy || !file || cooldownMs > 0}
            onClick={() => formRef.current?.requestSubmit()}
          >
            {busy ? (
              <>
                <Spinner /> {phase === 'optimizing' ? 'Preparing image…' : `Uploading… ${uploadProgress}%`}
              </>
            ) : (
              'Upload screenshot'
            )}
          </Button>
        </div>
      }
    >
      <form
        ref={formRef}
        id="screenshot-upload-form"
        onSubmit={e => {
          e.preventDefault()
          void submit()
        }}
        className="space-y-4"
      >
        <Select
          value={accountId}
          onChange={setAccountId}
          options={[
            { label: 'Select account', value: '' },
            ...accounts.map(a => ({ label: a.accountTitle, value: a.id })),
          ]}
          className="w-full"
        />

        <label className="block text-xs font-bold text-zinc-400">
          Screenshot date
          <input
            type="date"
            value={shotDate}
            onChange={e => setShotDate(e.target.value)}
            disabled={busy}
            className="mt-1 w-full rounded-xl border border-border bg-black/30 px-3 py-2.5 text-cream"
          />
        </label>

        {/* Hidden inputs — gallery has NO capture; camera uses capture only when user taps Take Photo */}
        <input
          ref={galleryRef}
          type="file"
          accept={TRADING_SCREENSHOT_GALLERY_ACCEPT}
          className="sr-only"
          disabled={busy}
          onChange={e => handleInputChange(e, 'gallery')}
        />
        <input
          ref={cameraRef}
          type="file"
          accept={TRADING_SCREENSHOT_CAMERA_ACCEPT}
          capture="environment"
          className="sr-only"
          disabled={busy}
          onChange={e => handleInputChange(e, 'camera')}
        />

        <UploadPickerSection
          busy={busy}
          file={file}
          pickSource={pickSource}
          previewUrl={previewUrl}
          previewBroken={previewBroken}
          setPreviewBroken={setPreviewBroken}
          dragOver={dragOver}
          setDragOver={setDragOver}
          pickFile={pickFile}
          clearSelection={clearSelection}
          onOpenGallery={() => !busy && galleryRef.current?.click()}
          onOpenCamera={() => !busy && cameraRef.current?.click()}
          cooldownMs={cooldownMs}
          userError={userError}
          uploadProgress={uploadProgress}
          phase={phase}
          recent={recent}
          accountId={accountId}
          showDebug={showDebug}
          debugLines={debugLines}
        />

        <textarea
          value={note}
          onChange={e => setNote(e.target.value)}
          rows={2}
          disabled={busy}
          placeholder="Optional note — orders, completion rate, growth…"
          className="w-full rounded-xl border border-border bg-black/30 px-3 py-2 text-sm text-cream outline-none focus:border-gold-dim/50"
        />

        {busy && phase === 'uploading' && (
          <div className="space-y-1">
            <UploadProgressBar percent={uploadProgress} />
            <Button variant="secondary" className="w-full min-h-[40px] justify-center" onClick={cancelUpload}>
              Cancel upload
            </Button>
          </div>
        )}
      </form>
    </ModalFrame>
  )
}

function SuccessContent({
  successShot,
  accountId,
  accounts,
  onClose,
  onAnother,
}: {
  successShot: TradingPerformanceScreenshot
  accountId: string
  accounts: TradingAccount[]
  onClose: () => void
  onAnother: () => void
}) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-green-400/30 bg-green-400/10 p-4">
        <p className="text-sm font-black text-green-200">Upload complete</p>
        <p className="mt-1 text-[11px] text-green-200/80">
          {accounts.find(a => a.id === accountId)?.accountTitle || 'Account'} ·{' '}
          {new Date(successShot.shotDate).toLocaleDateString('en-BD')} ·{' '}
          {new Date(successShot.createdAt || Date.now()).toLocaleTimeString('en-BD', { hour: '2-digit', minute: '2-digit' })}
        </p>
      </div>
      {successShot.signedUrl && (
        <img
          src={successShot.signedUrl}
          alt="Uploaded screenshot"
          loading="lazy"
          className="mx-auto max-h-56 w-full rounded-xl border border-border object-contain"
        />
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button variant="gold" className="min-h-[48px] justify-center" onClick={onClose}>Done</Button>
        <Button variant="secondary" className="min-h-[48px] justify-center" onClick={onAnother}>Upload another</Button>
      </div>
    </div>
  )
}

function UploadPickerSection({
  busy,
  file,
  pickSource,
  previewUrl,
  previewBroken,
  setPreviewBroken,
  dragOver,
  setDragOver,
  pickFile,
  clearSelection,
  onOpenGallery,
  onOpenCamera,
  cooldownMs,
  userError,
  uploadProgress,
  phase,
  recent,
  accountId,
  showDebug,
  debugLines,
}: {
  busy: boolean
  file: File | null
  pickSource: ScreenshotPickSource | null
  previewUrl: string | null
  previewBroken: boolean
  setPreviewBroken: (v: boolean) => void
  dragOver: boolean
  setDragOver: (v: boolean) => void
  pickFile: (f: File | null, source: ScreenshotPickSource) => void
  clearSelection: () => void
  onOpenGallery: () => void
  onOpenCamera: () => void
  cooldownMs: number
  userError: string | null
  uploadProgress: number
  phase: UploadPhase
  recent: TradingPerformanceScreenshot[]
  accountId: string
  showDebug: boolean
  debugLines: Array<Record<string, unknown>>
}) {
  return (
    <>
      <div className="grid grid-cols-2 gap-2">
        <Button
          type="button"
          variant="secondary"
          className="min-h-[52px] flex-col gap-1 justify-center touch-manipulation"
          disabled={busy}
          onClick={onOpenCamera}
        >
          <span className="text-lg" aria-hidden>📷</span>
          <span className="text-xs font-bold">Take Photo</span>
        </Button>
        <Button
          type="button"
          variant="secondary"
          className="min-h-[52px] flex-col gap-1 justify-center touch-manipulation"
          disabled={busy}
          onClick={onOpenGallery}
        >
          <span className="text-lg" aria-hidden>🖼</span>
          <span className="text-xs font-bold">Choose From Gallery</span>
        </Button>
      </div>

      <PreviewDropZone
        busy={busy}
        dragOver={dragOver}
        setDragOver={setDragOver}
        pickFile={pickFile}
        previewUrl={previewUrl}
        previewBroken={previewBroken}
        setPreviewBroken={setPreviewBroken}
        file={file}
        pickSource={pickSource}
        clearSelection={clearSelection}
        phase={phase}
        uploadProgress={uploadProgress}
      />

      {file && (
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
          <span>
            {file.name || 'photo'} · {(file.size / 1024).toFixed(0)} KB
            {pickSource ? ` · ${pickSource}` : ''}
            {file.type ? ` · ${file.type}` : ' · (type unknown)'}
          </span>
          {!busy && (
            <button type="button" onClick={clearSelection} className="inline-flex items-center gap-1 text-amber-300">
              Clear
            </button>
          )}
        </div>
      )}

      {phase === 'optimizing' && (
        <p className="text-[11px] text-zinc-400">Preparing image for upload…</p>
      )}

      {cooldownMs > 0 && (
        <p className="text-[11px] text-amber-300">Upload cooldown · {Math.ceil(cooldownMs / 1000)}s remaining</p>
      )}

      {userError && (
        <div className="rounded-xl border border-red-400/30 bg-red-400/10 px-3 py-2 text-xs text-red-200" role="alert">
          {userError}
        </div>
      )}

      {showDebug && debugLines.length > 0 && (
        <details className="rounded-xl border border-border bg-black/30 p-2 text-[10px] text-zinc-500">
          <summary className="cursor-pointer font-bold text-zinc-400">Upload debug log</summary>
          <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap">{JSON.stringify(debugLines.slice(-8), null, 2)}</pre>
        </details>
      )}

      {accountId && (
        <div className="rounded-2xl border border-border bg-black/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-black uppercase tracking-[0.12em] text-zinc-500">Recent uploads</p>
            <Link href={`/trading/accounts/${accountId}?tab=PERFORMANCE`} className="text-[10px] font-bold text-gold-lt">
              Full history →
            </Link>
          </div>
          {recent.length ? (
            <RecentThumbnails recent={recent} />
          ) : (
            <p className="mt-2 text-[11px] text-zinc-500">No screenshots yet for this account.</p>
          )}
        </div>
      )}
    </>
  )
}

function PreviewDropZone({
  busy,
  dragOver,
  setDragOver,
  pickFile,
  previewUrl,
  previewBroken,
  setPreviewBroken,
  file,
  pickSource,
  clearSelection,
  phase,
  uploadProgress,
}: {
  busy: boolean
  dragOver: boolean
  setDragOver: (v: boolean) => void
  pickFile: (f: File | null, source: ScreenshotPickSource) => void
  previewUrl: string | null
  previewBroken: boolean
  setPreviewBroken: (v: boolean) => void
  file: File | null
  pickSource: ScreenshotPickSource | null
  clearSelection: () => void
  phase: UploadPhase
  uploadProgress: number
}) {
  return (
    <div
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault()
        setDragOver(false)
        pickFile(e.dataTransfer.files?.[0] ?? null, 'drop')
      }}
      className={`rounded-2xl border-2 border-dashed p-4 text-center transition-colors ${dragOver ? 'border-gold-dim/60 bg-gold/10' : 'border-border bg-black/20'} ${busy ? 'opacity-60' : ''}`}
    >
      {previewUrl && file && !previewBroken && !isHeicLike(file) ? (
        <img
          src={previewUrl}
          alt="Preview"
          loading="lazy"
          className="mx-auto max-h-48 w-full rounded-xl object-contain"
          onError={() => {
            setPreviewBroken(true)
            logTradingUpload('preview:broken', { heic: isHeicLike(file), type: file.type })
          }}
        />
      ) : file && (previewBroken || isHeicLike(file)) ? (
        <div className="mx-auto max-w-xs rounded-xl border border-border bg-black/40 px-4 py-6">
          <span className="text-3xl" aria-hidden>🖼</span>
          <p className="mt-2 text-sm font-bold text-cream">Image ready to upload</p>
          <p className="mt-1 text-[11px] text-zinc-500">
            {isHeicLike(file) ? 'HEIC preview not supported in browser — server will convert.' : 'Preview unavailable — upload will still work.'}
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm font-bold text-cream">Select a screenshot above</p>
          <p className="mt-1 text-[11px] text-zinc-500">Or drag & drop on desktop</p>
        </>
      )}

      {busy && phase === 'uploading' && (
        <div className="mt-3">
          <UploadProgressBar percent={uploadProgress} />
        </div>
      )}

      {file && !busy && (
        <button type="button" onClick={clearSelection} className="mt-3 text-[11px] font-bold text-zinc-400 underline">
          Remove image
        </button>
      )}
    </div>
  )
}

function UploadProgressBar({ percent }: { percent: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-black/40">
      <div
        className="h-full rounded-full bg-gold transition-[width] duration-200"
        style={{ width: `${Math.max(2, percent)}%` }}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
  )
}

function RecentThumbnails({ recent }: { recent: TradingPerformanceScreenshot[] }) {
  return (
    <div className="mt-2 grid grid-cols-4 gap-2">
      {recent.map(shot => (
        <a key={shot.id} href={shot.signedUrl} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border border-border">
          {shot.signedUrl && (
            <img src={shot.signedUrl} alt="" loading="lazy" className="aspect-square w-full object-cover" />
          )}
        </a>
      ))}
    </div>
  )
}
