'use client'
import { useEffect, useState } from 'react'
import { PageHeader, Card, Button, Skeleton } from '@/components/ui'
import { BusinessSwitcherCompact } from '@/components/layout/BusinessSwitcher'
import { useBusiness } from '@/contexts/BusinessContext'
import { useBranding } from '@/contexts/BrandingContext'
import { api } from '@/lib/api'
import type { BrandAssetType } from '@/types/branding'
import toast from 'react-hot-toast'

function fileToBase64(file: File): Promise<{ data: string; mime: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result || '')
      const base64 = result.includes('base64,') ? result.split('base64,')[1] : result
      resolve({ data: base64, mime: file.type || 'image/png' })
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

export default function BrandingSettingsPage() {
  const { business } = useBusiness()
  const { branding, loading, refetch } = useBranding()
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState<BrandAssetType | null>(null)
  const [form, setForm] = useState({
    company_name: '', tagline: '', phone: '', email: '', website: '', address: '', facebook: '',
    color_primary: '#C9A84C', color_secondary: '#8B6914', color_accent: '#F0D080',
    invoice_footer_thanks: '', invoice_footer_policy: '', invoice_footer_note: '',
    invoice_prefix: '',
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
      color_primary: branding.color_primary || '#C9A84C',
      color_secondary: branding.color_secondary || '#8B6914',
      color_accent: branding.color_accent || '#F0D080',
      invoice_footer_thanks: branding.invoice_footer_thanks || '',
      invoice_footer_policy: branding.invoice_footer_policy || '',
      invoice_footer_note: branding.invoice_footer_note || '',
      invoice_prefix: branding.invoice_prefix || '',
    })
  }, [branding])

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

  async function handleUpload(assetType: BrandAssetType, file: File | null) {
    if (!file) return
    setUploading(assetType)
    try {
      const { data, mime } = await fileToBase64(file)
      const r = await api.branding.uploadAsset({
        asset_type: assetType,
        data,
        mime_type: mime,
        filename: file.name,
        business_id: business.id,
      })
      if (r?.ok) {
        toast.success(`${assetType === 'logo' ? 'Logo' : 'Favicon'} uploaded permanently`)
        await refetch()
      } else toast.error('Upload failed')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(null)
    }
  }

  return (
    <div>
      <PageHeader
        title="Settings · Branding"
        subtitle={`Permanent brand assets for ${business.name}`}
        actions={<BusinessSwitcherCompact />}
      />
      <div className="p-4 md:p-8 space-y-6 pb-24 md:pb-8 max-w-3xl">
        {loading ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <Card className="p-5 space-y-4">
              <p className="text-sm font-bold text-cream">Brand assets</p>
              <p className="text-[11px] text-zinc-500">
                Files are stored permanently in Google Drive and used on invoices, PDFs, dashboards, and print layouts.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Logo</p>
                  <div className="h-20 rounded-xl border border-border bg-black/40 flex items-center justify-center p-3">
                    {branding?.logo_url ? (
                      <img src={branding.logo_url} alt="Logo" className="max-h-full max-w-full object-contain" />
                    ) : (
                      <span className="text-xs text-zinc-600">No logo</span>
                    )}
                  </div>
                  <label className="block">
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/svg+xml"
                      className="text-xs text-zinc-400"
                      disabled={uploading === 'logo'}
                      onChange={e => handleUpload('logo', e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {uploading === 'logo' && <p className="text-[10px] text-gold">Uploading…</p>}
                </div>
                <div className="space-y-2">
                  <p className="text-[10px] uppercase tracking-wider text-zinc-500">Favicon</p>
                  <div className="h-20 rounded-xl border border-border bg-black/40 flex items-center justify-center p-3">
                    {branding?.favicon_url ? (
                      <img src={branding.favicon_url} alt="Favicon" className="max-h-10 max-w-10 object-contain" />
                    ) : (
                      <span className="text-xs text-zinc-600">No favicon</span>
                    )}
                  </div>
                  <label className="block">
                    <input
                      type="file"
                      accept="image/png,image/x-icon,image/jpeg"
                      className="text-xs text-zinc-400"
                      disabled={uploading === 'favicon'}
                      onChange={e => handleUpload('favicon', e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {uploading === 'favicon' && <p className="text-[10px] text-gold">Uploading…</p>}
                </div>
              </div>
            </Card>

            <Card className="p-5 space-y-4">
              <p className="text-sm font-bold text-cream">Company details</p>
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
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
                    <input
                      className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream"
                      value={form[key]}
                      onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                    />
                  </label>
                ))}
              </div>
            </Card>

            <Card className="p-5 space-y-4">
              <p className="text-sm font-bold text-cream">Brand colors</p>
              <div className="grid grid-cols-3 gap-4">
                {([
                  ['color_primary', 'Primary'],
                  ['color_secondary', 'Secondary'],
                  ['color_accent', 'Accent'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="block">
                    <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
                    <div className="flex gap-2 mt-1 items-center">
                      <input
                        type="color"
                        value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                        className="w-10 h-10 rounded border border-border bg-transparent cursor-pointer"
                      />
                      <input
                        className="flex-1 bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream font-mono"
                        value={form[key]}
                        onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                      />
                    </div>
                  </label>
                ))}
              </div>
            </Card>

            <Card className="p-5 space-y-4">
              <p className="text-sm font-bold text-cream">Invoice footer</p>
              {([
                ['invoice_footer_thanks', 'Thank you line'],
                ['invoice_footer_policy', 'Policy / terms'],
                ['invoice_footer_note', 'Legal note'],
              ] as const).map(([key, label]) => (
                <label key={key} className="block">
                  <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
                  <textarea
                    className="mt-1 w-full bg-card border border-border rounded-xl px-3 py-2 text-sm text-cream min-h-[64px]"
                    value={form[key]}
                    onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}
                  />
                </label>
              ))}
            </Card>

            <Button variant="gold" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : 'Save branding'}
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
