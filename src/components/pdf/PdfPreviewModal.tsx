'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { PDFDownloadLink } from '@react-pdf/renderer'
import { PremiumInvoiceDocument } from '@/components/pdf/PremiumInvoiceDocument'
import type { InvoicePdfModel } from '@/lib/pdf/types'
import { enrichPdfModel } from '@/lib/pdf/enrich'
import { generateInvoicePdfBlob } from '@/lib/pdf/generate'
import { resetPdfFonts } from '@/lib/pdf/fonts'
import { pdfSafeMode, PDF_GENERATE_TIMEOUT_MS, PDF_ENRICH_TIMEOUT_MS } from '@/lib/pdf/config'
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

export function PdfPreviewModal({
  open,
  onClose,
  baseModel,
  shareSlug,
  onSaveToDrive,
  saveToDriveLoading,
}: {
  open: boolean
  onClose: () => void
  baseModel: InvoicePdfModel | null
  shareSlug?: string
  onSaveToDrive?: () => void
  saveToDriveLoading?: boolean
}) {
  const [preparedModel, setPreparedModel] = useState<InvoicePdfModel | null>(null)
  const [phase, setPhase] = useState<PreviewPhase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [errorDetails, setErrorDetails] = useState<string | null>(null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [blobSize, setBlobSize] = useState(0)
  const [viewerMode, setViewerMode] = useState<'object' | 'embed'>('object')
  const [zoom, setZoom] = useState(100)

  const blobRef = useRef<Blob | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const generatedForRef = useRef<string | null>(null)
  const genRef = useRef(0)

  const revokeBlobUrl = useCallback(() => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
      pdfDebug('revoked object URL')
    }
    blobRef.current = null
    setBlobUrl(null)
    setBlobSize(0)
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

    const invoiceKey = preparedModel.invoiceId
    if (generatedForRef.current === invoiceKey && blobUrlRef.current) {
      pdfDebug('skip generate — already have blob for', invoiceKey)
      setPhase('ready')
      setBlobUrl(blobUrlRef.current)
      return
    }

    const genId = ++genRef.current
    let cancelled = false

    async function run() {
      setPhase('generating')
      pdfDebug('generating PDF', { genId, invoiceId: invoiceKey })

      const result = await generateInvoicePdfBlob(preparedModel!)

      if (cancelled || genId !== genRef.current) return

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

      setBlobUrl(url)
      setBlobSize(result.blob.size)
      setPhase('ready')
      pdfDebug('preview ready', { size: result.blob.size, invoiceId: invoiceKey })
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

  if (!open) return null

  const loading = phase === 'preparing' || phase === 'generating'
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
        <div className="flex items-center justify-between gap-2 px-3 py-3 md:px-6 border-b border-border bg-surface/95 backdrop-blur shrink-0 safe-top">
          <div className="min-w-0">
            <p className="text-sm font-bold text-cream truncate">
              {displayModel?.invoiceId || baseModel?.invoiceId || 'Invoice'}
            </p>
            <p className="text-[10px] text-zinc-500">
              {displayModel?.branding.companyName || '—'}
              {showPreview && blobSize > 0 ? ` · ${(blobSize / 1024).toFixed(1)} KB` : ''}
              {loading ? ' · Generating…' : showPreview ? ' · Preview' : ''}
            </p>
          </div>
          <div className="flex items-center gap-1 flex-wrap justify-end">
            <button type="button" className="text-xs px-2 py-1 rounded-lg border border-border text-zinc-400" onClick={() => setZoom(z => Math.max(50, z - 10))}>−</button>
            <span className="text-[10px] text-zinc-500 w-10 text-center">{zoom}%</span>
            <button type="button" className="text-xs px-2 py-1 rounded-lg border border-border text-zinc-400" onClick={() => setZoom(z => Math.min(150, z + 10))}>+</button>
            {displayModel && showPreview && (
              <PDFDownloadLink document={<PremiumInvoiceDocument model={displayModel} />} fileName={fileName}>
                {({ loading: dl }) => (
                  <Button variant="gold" size="xs" disabled={dl}>{dl ? '…' : 'Download'}</Button>
                )}
              </PDFDownloadLink>
            )}
            <Button variant="ghost" size="xs" onClick={handlePrint} disabled={!showPreview && !displayModel}>Print</Button>
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
            <Button variant="ghost" size="xs" onClick={onClose}>Close</Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-auto p-3 md:p-6 flex flex-col items-center justify-start">
          {loading && (
            <div className="flex flex-col items-center justify-center gap-4 py-16">
              <div className="w-10 h-10 border-2 border-gold/30 border-t-gold rounded-full animate-spin" />
              <p className="text-sm text-zinc-400">
                {phase === 'preparing' ? 'Preparing invoice data…' : `Generating PDF… (max ${PDF_GENERATE_TIMEOUT_MS / 1000}s)`}
              </p>
              <p className="text-[10px] text-zinc-600 font-mono">
                {baseModel?.invoiceId}
                {pdfSafeMode() ? ' · safe mode' : ''}
              </p>
            </div>
          )}

          {showError && (
            <div className="max-w-md w-full rounded-2xl border border-red-400/30 bg-red-400/5 p-6 text-center space-y-4">
              <p className="text-sm font-bold text-red-400">Could not render PDF</p>
              <p className="text-xs text-zinc-400">{error}</p>
              {errorDetails && pdfDebugEnabled() && (
                <pre className="text-[9px] text-left text-zinc-600 overflow-auto max-h-24 p-2 bg-black/40 rounded">{errorDetails}</pre>
              )}
              <div className="flex gap-2 justify-center">
                <Button variant="gold" size="sm" onClick={retry}>Retry</Button>
                <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
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
            <div className="text-center py-16 text-zinc-500 text-sm space-y-3">
              <p>Preview URL missing after generation.</p>
              <Button variant="gold" size="sm" onClick={retry}>Retry</Button>
            </div>
          )}
        </div>
      </motion.div>
    </AnimatePresence>
  )
}
