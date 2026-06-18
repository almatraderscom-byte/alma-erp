'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import { enrichPdfModel } from '@/lib/pdf/enrich'
import { generateInvoicePdfBlob } from '@/lib/pdf/generate'
import { resetPdfFonts } from '@/lib/pdf/fonts'
import { pdfSafeMode, PDF_ENRICH_TIMEOUT_MS } from '@/lib/pdf/config'
import { withTimeout } from '@/lib/pdf/timeout'
import { publicShareUrl } from '@/lib/pdf/format'
import { A4_WIDTH_PT, A4_HEIGHT_PT } from '@/lib/pdf/a4'
import { printPdfBlob } from '@/lib/pdf/print'
import { pdfDebug, pdfDebugError, pdfDebugEnabled } from '@/lib/pdf/debug'
import { Button } from '@/components/ui'
import toast from 'react-hot-toast'

type PreviewPhase = 'idle' | 'preparing' | 'generating' | 'ready' | 'error'

const PREVIEW_WIDTH_PX = Math.round(A4_WIDTH_PT)
const PREVIEW_HEIGHT_PX = Math.round(A4_HEIGHT_PT)
const PREVIEW_BLOB_CACHE_TTL_MS = 10 * 60 * 1000
const PREVIEW_BLOB_CACHE_MAX = 8
const previewBlobCache = new Map<string, { blob: Blob; size: number; renderMs: number; createdAt: number }>()

function cacheKeyForModel(model: InvoicePdfModel) {
  return [
    model.invoiceId,
    model.total,
    model.paymentStatus,
    model.totalPaid,
    model.dueAmount,
    model.paidPercentage,
    model.payments.map(payment => `${payment.date}:${payment.amount}:${payment.method}`).join(','),
    model.branding.companyName,
    model.branding.logoUrl || '',
    model.branding.logoDataUrl ? `logo:${model.branding.logoDataUrl.length}` : '',
    model.branding.colorPrimary,
  ].join('|')
}

function readCachedBlob(key: string) {
  const cached = previewBlobCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.createdAt > PREVIEW_BLOB_CACHE_TTL_MS) {
    previewBlobCache.delete(key)
    return null
  }
  return cached
}

function writeCachedBlob(key: string, entry: { blob: Blob; size: number; renderMs: number }) {
  previewBlobCache.set(key, { ...entry, createdAt: Date.now() })
  while (previewBlobCache.size > PREVIEW_BLOB_CACHE_MAX) {
    const oldest = [...previewBlobCache.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0]
    if (!oldest) break
    previewBlobCache.delete(oldest[0])
  }
}

export function PdfPreviewModal({
  open,
  onClose,
  baseModel,
  shareSlug,
  externalUrl,
  onSaveToDrive,
  saveToDriveLoading,
  externalLoading,
  readinessLabel,
}: {
  open: boolean
  onClose: () => void
  baseModel: InvoicePdfModel | null
  shareSlug?: string
  externalUrl?: string
  onSaveToDrive?: () => void
  saveToDriveLoading?: boolean
  externalLoading?: boolean
  readinessLabel?: string
}) {
  const [preparedModel, setPreparedModel] = useState<InvoicePdfModel | null>(null)
  const [phase, setPhase] = useState<PreviewPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [blobSize, setBlobSize] = useState(0)
  const [renderMs, setRenderMs] = useState(0)
  const [viewerMode, setViewerMode] = useState<'object' | 'embed'>('object')
  const [zoom, setZoom] = useState(100)

  const blobRef = useRef<Blob | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const generatedForRef = useRef<string | null>(null)
  const genRef = useRef(0)
  const closeRef = useRef(onClose)

  useEffect(() => {
    closeRef.current = onClose
  }, [onClose])

  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
      pdfDebug('revoked object URL')
    }
    blobRef.current = null
    setBlobUrl(null)
    setBlobSize(0)
    setRenderMs(0)
    generatedForRef.current = null
  }, [])

  const resetAll = useCallback(() => {
    revokeBlobUrl()
    setPreparedModel(null)
    setPhase('idle')
    setError(null)
    setErrorDetails(null)
    setViewerMode('object')
  }, [revokeBlobUrl])

  const requestClose = useCallback(() => {
    genRef.current += 1
    closeRef.current()
  }, [])

  useEffect(() => {
    if (!open) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') requestClose()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
    }
  }, [open, requestClose])

  // Step 1–4: enrich when modal opens
  useEffect(() => {
    if (!open || !baseModel) {
      resetAll()
      return
    }

    let cancelled = false
    const invoiceKey = baseModel.invoiceId

    setPhase('preparing')
    setError(null)
    setErrorDetails(null)
    revokeBlobUrl()

    pdfDebug('modal open', { invoiceId: invoiceKey })

    withTimeout(enrichPdfModel(baseModel), PDF_ENRICH_TIMEOUT_MS, 'prepare invoice')
      .then(m => {
        if (cancelled) return
        pdfDebug('enrich complete', { invoiceId: m.invoiceId })
        setPreparedModel(m)
      })
      .catch(err => {
        pdfDebugError('enrich failed', err)
        if (!cancelled) {
          setError('Could not prepare invoice data')
          setErrorDetails(err instanceof Error ? err.message : null)
          setPhase('error')
        }
      })

    return () => {
      cancelled = true
    }
  }, [open, baseModel, resetAll, revokeBlobUrl])

  // Step 5–11: generate PDF once per invoice (do NOT update preparedModel after — avoids re-run loop)
  useEffect(() => {
    if (!open || !preparedModel) return

    const invoiceKey = cacheKeyForModel(preparedModel)
    if (generatedForRef.current === invoiceKey && blobUrlRef.current) {
      pdfDebug('skip generate — already have blob for', invoiceKey)
      setPhase('ready')
      setBlobUrl(blobUrlRef.current)
      return
    }

    const cached = readCachedBlob(invoiceKey)
    if (cached) {
      revokeBlobUrl()
      const url = URL.createObjectURL(cached.blob)
      blobRef.current = cached.blob
      blobUrlRef.current = url
      generatedForRef.current = invoiceKey
      setBlobUrl(url)
      setBlobSize(cached.size)
      setRenderMs(cached.renderMs)
      setPhase('ready')
      pdfDebug('preview ready from cache', { size: cached.size, invoiceId: preparedModel.invoiceId, durationMs: cached.renderMs })
      return
    }

    const genId = ++genRef.current
    let cancelled = false

    async function run() {
      setPhase('generating')
      pdfDebug('generating PDF', { genId, invoiceId: invoiceKey })

      const result = await generateInvoicePdfBlob(preparedModel!)

      if (cancelled || genId !== genRef.current) return
      if (generatedForRef.current === invoiceKey && blobUrlRef.current) return

      if (!result.ok) {
        pdfDebugError('generate failed', result.error)
        setError(result.error)
        setErrorDetails(result.details ?? null)
        setPhase('error')
        return
      }

      revokeBlobUrl()

      const url = URL.createObjectURL(result.blob)
      blobRef.current = result.blob
      blobUrlRef.current = url
      generatedForRef.current = invoiceKey
      writeCachedBlob(invoiceKey, { blob: result.blob, size: result.blob.size, renderMs: result.durationMs })

      setBlobUrl(url)
      setBlobSize(result.blob.size)
      setRenderMs(result.durationMs)
      setPhase('ready')
      pdfDebug('preview ready', { size: result.blob.size, invoiceId: invoiceKey, durationMs: result.durationMs })
    }

    run().catch(err => {
      if (cancelled) return
      pdfDebugError('generate unexpected', err)
      setError(err instanceof Error ? err.message : 'PDF generation failed')
      setPhase('error')
    })

    return () => {
      cancelled = true
    }
  }, [open, preparedModel, revokeBlobUrl])

  // Cleanup blob URL when modal closes
  useEffect(() => {
    if (!open) {
      revokeBlobUrl()
      setPreparedModel(null)
      setPhase('idle')
    }
  }, [open, revokeBlobUrl])

  const displayModel = preparedModel
  const fileName = `${(displayModel?.invoiceId || 'invoice').replace(/[^\w-]+/g, '-')}.pdf`
  const shareLink = shareSlug ? publicShareUrl(shareSlug) : ''

  const retry = useCallback(() => {
    if (!baseModel) return
    resetPdfFonts()
    generatedForRef.current = null
    revokeBlobUrl()
    setError(null)
    setErrorDetails(null)
    setPhase('preparing')
    withTimeout(enrichPdfModel(baseModel), PDF_ENRICH_TIMEOUT_MS, 'prepare invoice')
      .then(setPreparedModel)
      .catch(() => setPhase('error'))
  }, [baseModel, revokeBlobUrl])

  const handlePrint = useCallback(() => {
    if (blobRef.current) {
      printPdfBlob(blobRef.current)
      return
    }
    if (!displayModel) return
    generateInvoicePdfBlob(displayModel).then(result => {
      if (result.ok) printPdfBlob(result.blob)
      else toast.error('Print failed')
    })
  }, [displayModel])

  const handleDownload = useCallback(() => {
    if (!blobRef.current) return
    const url = URL.createObjectURL(blobRef.current)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    document.body.appendChild(a)
    a.click()
    a.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1500)
  }, [fileName])

  const copyShare = useCallback(async () => {
    if (!shareLink) {
      toast.error('No share link')
      return
    }
    try {
      await navigator.clipboard.writeText(shareLink)
      toast.success('Link copied')
    } catch {
      toast.error('Copy failed')
    }
  }, [shareLink])

  const whatsappShare = useCallback(() => {
    if (!shareLink) return
    window.open(
      `https://wa.me/?text=${encodeURIComponent(`Invoice ${displayModel?.invoiceId}: ${shareLink}`)}`,
      '_blank',
      'noopener,noreferrer',
    )
  }, [shareLink, displayModel?.invoiceId])

  const emailShare = useCallback(() => {
    if (!displayModel) return
    const sub = encodeURIComponent(`Invoice ${displayModel.invoiceId}`)
    const body = encodeURIComponent(`Please find your invoice:\n${shareLink || ''}`)
    window.location.href = `mailto:?subject=${sub}&body=${body}`
  }, [displayModel, shareLink])

  const openExternally = useCallback(() => {
    const url = externalUrl || blobUrl
    if (!url) return
    window.open(url, '_blank', 'noopener,noreferrer')
  }, [externalUrl, blobUrl])

  if (!open) return null

  const loading = externalLoading || phase === 'preparing' || phase === 'generating'
  const showError = phase === 'error' && error
  const showPreview = phase === 'ready' && !!blobUrl

  const zoomScale = zoom / 100
  const frameW = Math.round(PREVIEW_WIDTH_PX * zoomScale)
  const frameH = Math.round(PREVIEW_HEIGHT_PX * zoomScale)

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex flex-col bg-black/90"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <button
          type="button"
          aria-label="Close invoice preview"
          className="absolute inset-0 cursor-default"
          onClick={requestClose}
        />
        <div className="relative z-[2] flex items-center justify-between gap-2 px-3 py-3 md:px-6 border-b border-border bg-surface/95 backdrop-blur shrink-0 safe-top">
          <div className="min-w-0">
            <p className="text-sm font-bold text-cream truncate">
              {displayModel?.invoiceId || baseModel?.invoiceId || 'Invoice'}
            </p>
            <p className="text-[10px] text-muted">
              {displayModel?.branding.companyName || '—'}
              {showPreview && blobSize > 0 ? ` · ${(blobSize / 1024).toFixed(1)} KB` : ''}
              {showPreview && renderMs > 0 ? ` · ${(renderMs / 1000).toFixed(1)}s` : ''}
              {loading ? ` · ${readinessLabel || 'Generating…'}` : showPreview ? ' · Preview' : ''}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <button type="button" className="text-xs px-2 py-1 rounded-lg border border-border text-muted" onClick={() => setZoom(z => Math.max(50, z - 10))}>−</button>
            <span className="text-[10px] text-muted w-10 text-center">{zoom}%</span>
            <button type="button" className="text-xs px-2 py-1 rounded-lg border border-border text-muted" onClick={() => setZoom(z => Math.min(150, z + 10))}>+</button>
            {displayModel && showPreview && <Button variant="gold" size="xs" onClick={handleDownload}>Download</Button>}
            <Button variant="ghost" size="xs" onClick={handlePrint} disabled={!showPreview && !displayModel}>Print</Button>
            {(externalUrl || blobUrl) && (
              <Button variant="ghost" size="xs" onClick={openExternally}>Open externally</Button>
            )}
            {shareLink && (
              <>
                <Button variant="ghost" size="xs" onClick={copyShare}>Copy link</Button>
                <Button variant="ghost" size="xs" onClick={whatsappShare}>WhatsApp</Button>
                <Button variant="ghost" size="xs" onClick={emailShare}>Email</Button>
              </>
            )}
            {onSaveToDrive && (
              <Button variant="ghost" size="xs" onClick={onSaveToDrive} disabled={saveToDriveLoading}>
                {saveToDriveLoading ? 'Saving…' : 'Drive backup'}
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={requestClose}>Close</Button>
          </div>
        </div>

        <div className="relative z-[1] flex-1 min-h-0 overflow-auto p-3 md:p-6 flex flex-col items-center justify-start">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <div className="w-10 h-10 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
              <p className="text-sm text-muted">
                {externalLoading ? (readinessLabel || 'Resolving invoice assets…') : phase === 'preparing' ? 'Preparing invoice data…' : 'Generating print-ready PDF…'}
              </p>
              <p className="text-[10px] text-muted-hi font-mono">
                {baseModel?.invoiceId}
                {pdfSafeMode() ? ' · safe mode' : ''}
              </p>
            </div>
          )}

          {showError && (
            <div className="max-w-md w-full rounded-2xl border border-red-400/30 bg-red-400/5 p-6 text-center space-y-4">
              <p className="text-sm font-bold text-red-400">Could not render PDF</p>
              <p className="text-xs text-muted">{error}</p>
              {errorDetails && pdfDebugEnabled() && (
                <pre className="text-[9px] text-left text-muted-hi overflow-auto max-h-24 p-2 bg-white/[0.04] rounded">{errorDetails}</pre>
              )}
              <div className="flex gap-2 justify-center">
                <Button variant="gold" size="sm" onClick={retry}>Retry</Button>
                {externalUrl && <Button variant="secondary" size="sm" onClick={openExternally}>Open externally</Button>}
                <Button variant="ghost" size="sm" onClick={requestClose}>Close</Button>
              </div>
            </div>
          )}

          {showPreview && blobUrl && (
            <div
              className="pdf-blob-preview shrink-0"
              style={{ width: frameW, height: frameH }}
            >
              {viewerMode === 'object' ? (
                <object
                  key={blobUrl}
                  data={blobUrl}
                  type="application/pdf"
                  className="pdf-blob-object"
                  aria-label="Invoice PDF preview"
                >
                  <embed
                    src={blobUrl}
                    type="application/pdf"
                    className="pdf-blob-embed"
                  />
                </object>
              ) : (
                <embed
                  key={`embed-${blobUrl}`}
                  src={blobUrl}
                  type="application/pdf"
                  className="pdf-blob-embed"
                />
              )}
            </div>
          )}

          {phase === 'ready' && !blobUrl && (
            <div className="text-center py-16 text-muted text-sm space-y-3">
              <p>Preview URL missing after generation.</p>
              <Button variant="gold" size="sm" onClick={retry}>Retry</Button>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
