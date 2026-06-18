'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { PageHeader, Card, Button, Skeleton } from '@/components/ui'
import { BusinessSwitcherCompact } from '@/components/layout/BusinessSwitcher'
import { useBusiness } from '@/contexts/BusinessContext'
import { useBranding } from '@/contexts/BrandingContext'
import { api } from '@/lib/api'
import type { BrandAssetType } from '@/types/branding'
import toast from 'react-hot-toast'

const stagger = { hidden: {}, show: { transition: { staggerChildren: 0.04 } } }
const fadeUp = { hidden: { opacity: 0, y: 6 }, show: { opacity: 1, y: 0, transition: { duration: 0.25 } } }

type AssetDraft = {
  file: File
  previewUrl: string
  width: number
  height: number
  warnings: string[]
  errors: string[]
}

const ASSET_RULES = {
  logo: {
    label: 'Logo',
    accept: 'image/png,image/jpeg,image/webp,image/svg+xml',
    recommended: '1200x400 PNG',
    ratioText: '3:1',
    minWidth: 900,
    minHeight: 300,
    ratio: 3,
    ratioTolerance: 0.25,
    targetWidth: 1200,
    targetHeight: 400,
    helper: 'Transparent background preferred. Wide logos fit best in invoices and dashboard headers.',
  },
  favicon: {
    label: 'Favicon / PWA icon',
    accept: 'image/png,image/jpeg,image/webp',
    recommended: '512x512 PNG',
    ratioText: '1:1 square',
    minWidth: 512,
    minHeight: 512,
    ratio: 1,
    ratioTolerance: 0.04,
    targetWidth: 512,
    targetHeight: 512,
    helper: 'Square image required. This also powers browser tab, mobile, and PWA home-screen branding.',
  },
} as const satisfies Record<BrandAssetType, {
  label: string
  accept: string
  recommended: string
  ratioText: string
  minWidth: number
  minHeight: number
  ratio: number
  ratioTolerance: number
  targetWidth: number
  targetHeight: number
  helper: string
}>

const SUPPORTED_MIME = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'])

function brandImageSrc(url: string) {
  return `/api/branding/image-proxy?raw=1&url=${encodeURIComponent(url)}`
}

function fileToBase64(file: Blob, fallbackMime?: string): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const base64 = result.includes('base64,') ? result.split('base64,')[1] : result
      resolve({ data: base64, mime: file.type || fallbackMime || 'image/png' })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function loadImageMeta(file: File): Promise<{ width: number; height: number; previewUrl: string }> {
  return new Promise((resolve, reject) => {
    const previewUrl = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height, previewUrl })
    img.onerror = () => {
      URL.revokeObjectURL(previewUrl)
      reject(new Error('Could not read image dimensions. Try a PNG or JPG file.'))
    }
    img.src = previewUrl
  })
}

function validateAsset(assetType: BrandAssetType, file: File, width: number, height: number) {
  const rules = ASSET_RULES[assetType]
  const warnings: string[] = []
  const errors: string[] = []
  const ratio = width && height ? width / height : 0

  if (!SUPPORTED_MIME.has(file.type)) errors.push('Unsupported file type. Use PNG, JPG, or WebP.')
  if (assetType === 'logo' && file.type === 'image/svg+xml') warnings.push('SVG can work in the dashboard, but PNG is safest for PDFs.')
  if (width < rules.minWidth || height < rules.minHeight) {
    warnings.push(`Resolution is ${width}x${height}. Recommended minimum is ${rules.minWidth}x${rules.minHeight}.`)
  }
  if (Math.abs(ratio - rules.ratio) > rules.ratioTolerance) {
    const message = `${rules.label} ratio is ${ratio.toFixed(2)}:1. Recommended is ${rules.ratioText}.`
    if (assetType === 'favicon') errors.push(`${message} Upload a square image.`)
    else warnings.push(message)
  }
  if (file.size > 5_000_000) warnings.push('Large file detected. Auto optimize is recommended for faster PDFs and mobile loading.')

  return { warnings, errors }
}

function optimizeImage(file: File, assetType: BrandAssetType): Promise<Blob> {
  const rules = ASSET_RULES[assetType]
  return new Promise((resolve, reject) => {
    if (file.type === 'image/svg+xml') {
      resolve(file)
      return
    }
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = rules.targetWidth
      canvas.height = rules.targetHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        URL.revokeObjectURL(url)
        reject(new Error('Could not optimize image'))
        return
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight)
      const width = Math.round(img.naturalWidth * scale)
      const height = Math.round(img.naturalHeight * scale)
      const x = Math.round((canvas.width - width) / 2)
      const y = Math.round((canvas.height - height) / 2)
      ctx.drawImage(img, x, y, width, height)
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url)
        if (!blob) reject(new Error('Could not optimize image'))
        else resolve(blob)
      }, 'image/png')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not optimize image'))
    }
    img.src = url
  })
}

export default function BrandingSettingsPage() {
  const { business } = useBusiness()
  const { branding, loading, refetch } = useBranding()
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<BrandAssetType | null>(null)
  const [drafts, setDrafts] = useState<Partial<Record<BrandAssetType, AssetDraft>>>({})
  const [autoOptimize, setAutoOptimize] = useState<Record<BrandAssetType, boolean>>({ logo: true, favicon: true })
  const draftUrlsRef = useRef<string[]>([])
  const [form, setForm] = useState({
    company_name: '', tagline: '', phone: '', email: '', website: '', address: '', facebook: '',
    color_primary: '#E07A5F', color_secondary: '#C45A3C', color_accent: '#F4A28C',
    invoice_footer_thanks: '', invoice_footer_policy: '', invoice_footer_note: '',
    invoice_prefix: '',
    invoice_watermark_enabled: true,
    invoice_watermark_opacity: '0.08',
  })

  useEffect(() => {
    if (!branding) return
    setForm({
      company_name: branding.company_name || '',
      tagline: branding.tagline || '',
      phone: branding.phone || '',
      email: branding.email || '',
      website: branding.website || '',
      address: branding.address || '',
      facebook: branding.facebook || '',
      color_primary: branding.color_primary || '#E07A5F',
      color_secondary: branding.color_secondary || '#C45A3C',
      color_accent: branding.color_accent || '#F0D080',
      invoice_footer_thanks: branding.invoice_footer_thanks || '',
      invoice_footer_policy: branding.invoice_footer_policy || '',
      invoice_footer_note: branding.invoice_footer_note || '',
      invoice_prefix: branding.invoice_prefix || '',
      invoice_watermark_enabled: branding.invoice_watermark_enabled !== false,
      invoice_watermark_opacity: branding.invoice_watermark_opacity || '0.08',
    })
  }, [branding])

  useEffect(() => {
    draftUrlsRef.current = Object.values(drafts).map(draft => draft?.previewUrl).filter(Boolean) as string[]
  }, [drafts])

  useEffect(() => () => {
    draftUrlsRef.current.forEach(url => URL.revokeObjectURL(url))
  }, [])

  const previewAssets = useMemo(() => ({
    logo: drafts.logo?.previewUrl || (branding?.logo_url ? brandImageSrc(branding.logo_url) : ''),
    favicon: drafts.favicon?.previewUrl || (branding?.favicon_url ? brandImageSrc(branding.favicon_url) : ''),
  }), [branding?.favicon_url, branding?.logo_url, drafts.favicon?.previewUrl, drafts.logo?.previewUrl])

  async function handleSave() {
    setSaving(true)
    try {
      await api.branding.save({ ...form, business_id: business.id })
      toast.success('Branding saved')
      await refetch()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function handleSelectAsset(assetType: BrandAssetType, file: File | null) {
    if (!file) return
    const oldDraft = drafts[assetType]
    if (oldDraft?.previewUrl) URL.revokeObjectURL(oldDraft.previewUrl)

    try {
      const meta = await loadImageMeta(file)
      const validation = validateAsset(assetType, file, meta.width, meta.height)
      setDrafts(d => ({
        ...d,
        [assetType]: { file, previewUrl: meta.previewUrl, width: meta.width, height: meta.height, ...validation },
      }))
      if (validation.errors.length) toast.error(validation.errors[0])
      else if (validation.warnings.length) toast(validation.warnings[0])
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  async function handleUpload(assetType: BrandAssetType) {
    const draft = drafts[assetType]
    if (!draft) return
    if (draft.errors.length) {
      toast.error('Fix the image validation issue before uploading.')
      return
    }
    setUploading(assetType)
    try {
      const uploadBlob = autoOptimize[assetType] ? await optimizeImage(draft.file, assetType) : draft.file
      const { data, mime } = await fileToBase64(uploadBlob, autoOptimize[assetType] ? 'image/png' : draft.file.type)
      const r = await api.branding.uploadAsset({
        asset_type: assetType,
        data,
        mime_type: mime,
        filename: autoOptimize[assetType] ? `${assetType}.png` : draft.file.name,
        business_id: business.id,
      })
      if (r?.ok) {
        toast.success(`${ASSET_RULES[assetType].label} uploaded permanently`)
        setDrafts(d => {
          const next = { ...d }
          const uploaded = next[assetType]
          if (uploaded?.previewUrl) URL.revokeObjectURL(uploaded.previewUrl)
          delete next[assetType]
          return next
        })
        await refetch()
      } else toast.error('Upload failed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(null)
    }
  }

  return (
    <div className="min-h-screen bg-transparent">
      <PageHeader
        title="Settings · Branding"
        subtitle={`Permanent brand assets for ${business.name}`}
        actions={<BusinessSwitcherCompact />}
      />
      <motion.div variants={stagger} initial="hidden" animate="show" className="p-4 md:p-8 space-y-6 pb-24 md:pb-8 max-w-3xl">
        {loading ? (
          <Skeleton className="h-64 rounded-2xl" />
        ) : (
          <>
            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-white/[0.06] p-6 space-y-5 shadow-sm">
                <div>
                  <h3 className="text-sm font-bold text-cream">Brand assets</h3>
                  <p className="mt-1 text-[11px] text-muted">
                    Files are stored permanently in Google Drive and used on invoices, PDFs, dashboards, and print layouts.
                  </p>
                </div>
                <div className="rounded-xl border border-[#E07A5F]/20 bg-[#E07A5F]/[0.04] p-4 text-[11px] text-muted-hi leading-relaxed space-y-1">
                  <p><span className="font-bold text-[#E07A5F]">Logo:</span> Recommended 1200x400 PNG, 3:1 aspect ratio, transparent background preferred.</p>
                  <p><span className="font-bold text-[#E07A5F]">Favicon:</span> Recommended 512x512 PNG, square image required.</p>
                  <p><span className="font-bold text-[#E07A5F]">PWA icon:</span> Recommended 512x512 PNG. Use the favicon/PWA icon upload for browser tab and home-screen branding.</p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  {(['logo', 'favicon'] as const).map(assetType => {
                    const rules = ASSET_RULES[assetType]
                    const draft = drafts[assetType]
                    const previewUrl = previewAssets[assetType]
                    const isLogo = assetType === 'logo'
                    return (
                      <div key={assetType} className="space-y-3 rounded-xl border border-white/[0.06] bg-white/[0.04]/50 p-4">
                        <div>
                          <p className="text-[10px] uppercase tracking-wider text-muted font-semibold">{rules.label}</p>
                          <p className="mt-1 text-[11px] text-muted">{rules.helper}</p>
                          <p className="mt-1 text-[10px] text-muted">Recommended: {rules.recommended} · Aspect ratio: {rules.ratioText}</p>
                        </div>
                        <div className={`rounded-xl border border-white/[0.06] bg-[linear-gradient(45deg,#f1f1f1_25%,transparent_25%),linear-gradient(-45deg,#f1f1f1_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#f1f1f1_75%),linear-gradient(-45deg,transparent_75%,#f1f1f1_75%)] bg-[length:18px_18px] bg-[position:0_0,0_9px,9px_-9px,-9px_0] flex items-center justify-center p-4 h-28`}>
                          {previewUrl ? (
                            <img
                              src={previewUrl}
                              alt={`${rules.label} preview`}
                              className={isLogo ? 'max-h-20 max-w-full object-contain' : 'h-16 w-16 rounded-xl object-contain bg-card/85 border border-white/[0.06] p-1'}
                            />
                          ) : (
                            <span className="text-xs text-muted">No {rules.label.toLowerCase()}</span>
                          )}
                        </div>
                        {draft && (
                          <div className="space-y-1">
                            <p className="text-[10px] text-muted">
                              Selected: {draft.width}x{draft.height} · {(draft.file.size / 1024).toFixed(0)} KB
                            </p>
                            {draft.warnings.map(w => <p key={w} className="text-[10px] text-amber-600">Warning: {w}</p>)}
                            {draft.errors.map(e => <p key={e} className="text-[10px] text-red-600">Fix needed: {e}</p>)}
                          </div>
                        )}
                        <label className="block">
                          <span className="sr-only">Upload {rules.label}</span>
                          <input
                            type="file"
                            accept={rules.accept}
                            className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-[#E07A5F]/10 file:px-3 file:py-2 file:text-xs file:font-bold file:text-[#E07A5F]"
                            disabled={uploading === assetType}
                            onChange={e => void handleSelectAsset(assetType, e.target.files?.[0] ?? null)}
                          />
                        </label>
                        <label className="flex items-center gap-2 text-[11px] text-muted-hi">
                          <input
                            type="checkbox"
                            checked={autoOptimize[assetType]}
                            onChange={e => setAutoOptimize(v => ({ ...v, [assetType]: e.target.checked }))}
                            className="accent-[#E07A5F]"
                          />
                          Auto optimize {isLogo ? 'to 1200x400 transparent PNG' : 'to 512x512 transparent PNG'}
                        </label>
                        <Button
                          variant="gold"
                          size="sm"
                          className="w-full justify-center"
                          disabled={!draft || draft.errors.length > 0 || uploading === assetType}
                          onClick={() => void handleUpload(assetType)}
                        >
                          {uploading === assetType ? 'Uploading…' : draft ? `Upload ${rules.label}` : 'Choose image first'}
                        </Button>
                      </div>
                    )
                  })}
                </div>
              </Card>
            </motion.div>

            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-white/[0.06] p-6 space-y-4 shadow-sm">
                <h3 className="text-sm font-bold text-cream">Company details</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {([
                    ['company_name', 'Company name'],
                    ['tagline', 'Tagline'],
                    ['phone', 'Phone'],
                    ['email', 'Email'],
                    ['website', 'Website'],
                    ['address', 'Address'],
                    ['facebook', 'Facebook'],
                    ['invoice_prefix', 'Invoice prefix'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="text-[10px] text-muted uppercase tracking-wider font-medium">{label}</span>
                      <input
                        className="mt-1 w-full bg-card/85 border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20 focus:border-[#E07A5F]/40"
                        value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                      />
                    </label>
                  ))}
                </div>
              </Card>
            </motion.div>

            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-white/[0.06] p-6 space-y-4 shadow-sm">
                <div>
                  <h3 className="text-sm font-bold text-cream">Invoice watermark</h3>
                  <p className="mt-1 text-[11px] text-muted">
                    Uses the uploaded logo as a subtle centered invoice background. Defaults are print-safe and PDF optimized.
                  </p>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <label className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-card/85 px-4 py-3 text-sm text-cream">
                    <input
                      type="checkbox"
                      checked={form.invoice_watermark_enabled}
                      onChange={e => setForm(f => ({ ...f, invoice_watermark_enabled: e.target.checked }))}
                      className="accent-[#E07A5F]"
                    />
                    Enable invoice watermark
                  </label>
                  <label className="block">
                    <span className="text-[10px] text-muted uppercase tracking-wider font-medium">Watermark opacity</span>
                    <select
                      className="mt-1 w-full bg-card/85 border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-cream focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                      value={form.invoice_watermark_opacity}
                      onChange={e => setForm(f => ({ ...f, invoice_watermark_opacity: e.target.value }))}
                    >
                      <option value="0.07">7% subtle</option>
                      <option value="0.08">8% balanced</option>
                      <option value="0.10">10% visible</option>
                    </select>
                  </label>
                </div>
                <p className="text-[10px] text-muted">
                  These settings are backend-ready; current invoice PDFs use the safe default unless persisted branding config is available.
                </p>
              </Card>
            </motion.div>

            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-white/[0.06] p-6 space-y-4 shadow-sm">
                <h3 className="text-sm font-bold text-cream">Brand colors</h3>
                <div className="grid grid-cols-3 gap-4">
                  {([
                    ['color_primary', 'Primary'],
                    ['color_secondary', 'Secondary'],
                    ['color_accent', 'Accent'],
                  ] as const).map(([key, label]) => (
                    <label key={key} className="block">
                      <span className="text-[10px] text-muted uppercase tracking-wider font-medium">{label}</span>
                      <div className="flex gap-2 mt-1 items-center">
                        <input
                          type="color"
                          value={form[key]}
                          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                          className="w-10 h-10 rounded-lg border border-white/[0.06] bg-transparent cursor-pointer"
                        />
                        <input
                          className="flex-1 bg-card/85 border border-white/[0.06] rounded-xl px-3 py-2 text-sm text-cream font-mono focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20"
                          value={form[key]}
                          onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                        />
                      </div>
                    </label>
                  ))}
                </div>
              </Card>
            </motion.div>

            <motion.div variants={fadeUp}>
              <Card className="rounded-2xl border border-white/[0.06] p-6 space-y-4 shadow-sm">
                <h3 className="text-sm font-bold text-cream">Invoice footer</h3>
                {([
                  ['invoice_footer_thanks', 'Thank you line'],
                  ['invoice_footer_policy', 'Policy / terms'],
                  ['invoice_footer_note', 'Legal note'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[10px] text-muted uppercase tracking-wider font-medium">{label}</span>
                    <textarea
                      className="mt-1 w-full bg-card/85 border border-white/[0.06] rounded-xl px-3 py-2.5 text-sm text-cream min-h-[64px] focus:outline-none focus:ring-2 focus:ring-[#E07A5F]/20 focus:border-[#E07A5F]/40"
                      value={form[key]}
                      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    />
                  </label>
                ))}
              </Card>
            </motion.div>

            <motion.div variants={fadeUp}>
              <Button variant="gold" onClick={handleSave} disabled={saving}>
                {saving ? 'Saving…' : 'Save branding'}
              </Button>
            </motion.div>
          </>
        )}
      </motion.div>
    </div>
  )
}
