'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  attachProjectAsset,
  fetchProjectAssets,
  updateProjectAsset,
} from '@/agent/components/creative-studio/studio-api'
import { PerformanceView } from '@/agent/components/creative-studio/PerformanceView'
import { PublishPanel } from '@/agent/components/creative-studio/PublishPanel'
import { ReviewPanel } from '@/agent/components/creative-studio/ReviewPanel'
import type {
  StudioProjectAsset,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'

function statusLabel(status: string) {
  if (status === 'executed') return 'Ready'
  if (status === 'approved' || status === 'pending' || status === 'processing') return 'তৈরি হচ্ছে'
  if (status === 'failed' || status === 'error') return 'ব্যর্থ'
  return status
}

function AssetPreview({ asset }: { asset: StudioProjectAsset }) {
  if (asset.previewUrl && asset.assetType === 'video') {
    return <video src={asset.previewUrl} className="h-full w-full object-cover" muted playsInline />
  }
  if (asset.previewUrl && asset.assetType === 'audio') {
    return <div className="grid h-full place-items-center bg-gradient-to-br from-violet-950 to-bg-1 text-3xl">🎧</div>
  }
  if (asset.previewUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={asset.previewUrl} alt="" className="h-full w-full object-cover" />
  }
  return <div className="grid h-full place-items-center bg-white/[0.04] text-2xl">{asset.assetType === 'video' ? '🎬' : asset.assetType === 'audio' ? '🎧' : '🖼️'}</div>
}

export function ProjectLibraryView({
  project,
  onClose,
}: {
  project: StudioProjectSummary
  onClose: () => void
}) {
  const [assets, setAssets] = useState<StudioProjectAsset[]>([])
  const [selected, setSelected] = useState<StudioProjectAsset | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [folderFilter, setFolderFilter] = useState('সব')
  const [tagFilter, setTagFilter] = useState('সব')
  const [folder, setFolder] = useState('')
  const [tags, setTags] = useState('')
  const [saving, setSaving] = useState(false)
  const [legacyOpen, setLegacyOpen] = useState(false)
  const [legacyAssets, setLegacyAssets] = useState<StudioProjectAsset[]>([])
  const [legacyLoading, setLegacyLoading] = useState(false)
  const [attaching, setAttaching] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchProjectAssets(project.id)
      setAssets(rows)
      setSelected((current) => current ? rows.find((item) => item.id === current.id) ?? null : null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Asset library লোড করা যায়নি।')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // Project ID is the complete server query scope.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id])

  useEffect(() => {
    setFolder(selected?.folder ?? '')
    setTags(selected?.tags.map((tag) => tag.name).join(', ') ?? '')
  }, [selected])

  const folders = useMemo(
    () => ['সব', ...new Set(assets.map((asset) => asset.folder))],
    [assets],
  )
  const allTags = useMemo(
    () => ['সব', ...new Set(assets.flatMap((asset) => asset.tags.map((tag) => tag.name)))],
    [assets],
  )
  const visible = useMemo(
    () => assets.filter((asset) => (
      (folderFilter === 'সব' || asset.folder === folderFilter)
      && (tagFilter === 'সব' || asset.tags.some((tag) => tag.name === tagFilter))
    )),
    [assets, folderFilter, tagFilter],
  )

  const saveMetadata = async () => {
    if (!selected || project.readonly) return
    setSaving(true)
    setError(null)
    try {
      const updated = await updateProjectAsset(project.id, {
        assetId: selected.id,
        folder,
        tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean),
      })
      setAssets((current) => current.map((asset) => asset.id === updated.id ? updated : asset))
      setSelected(updated)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Folder/tag সেভ করা যায়নি।')
    } finally {
      setSaving(false)
    }
  }

  const openLegacy = async () => {
    setLegacyOpen(true)
    setLegacyLoading(true)
    try {
      setLegacyAssets(await fetchProjectAssets('legacy'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Legacy collection লোড করা যায়নি।')
    } finally {
      setLegacyLoading(false)
    }
  }

  const importLegacy = async (legacy: StudioProjectAsset) => {
    if (!legacy.pendingActionId) return
    setAttaching(legacy.id)
    setError(null)
    try {
      const asset = await attachProjectAsset(project.id, {
        pendingActionId: legacy.pendingActionId,
        title: legacy.title ?? undefined,
        folder: project.defaultFolder,
        recipeId: project.currentRecipeId,
      })
      setAssets((current) => [asset, ...current.filter((item) => item.id !== asset.id)])
      setLegacyAssets((current) => current.filter((item) => item.id !== legacy.id))
      setSelected(asset)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Legacy asset যোগ করা যায়নি।')
    } finally {
      setAttaching(null)
    }
  }

  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-bg-1 text-cream">
      <div className="flex shrink-0 items-center justify-between border-b border-border-subtle bg-card/90 px-3 py-3 backdrop-blur-md">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-bold">{project.name} · Asset Library</h2>
          <p className="text-[10px] text-muted">{assets.length}টি asset · folders, tags, version ও lineage</p>
        </div>
        <div className="flex items-center gap-2">
          {!project.readonly && (
            <button type="button" onClick={() => void openLegacy()} className="rounded-xl bg-white/10 px-3 py-2 text-[10px] font-bold text-cream">
              Legacy থেকে যোগ
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="লাইব্রেরি বন্ধ করুন" className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-muted">✕</button>
        </div>
      </div>

      <div className="flex shrink-0 gap-2 overflow-x-auto border-b border-border-subtle px-3 py-2">
        <select value={folderFilter} onChange={(event) => setFolderFilter(event.target.value)} aria-label="Folder filter" className="rounded-lg border border-border-subtle bg-card px-2 py-1.5 text-[10px] text-cream">
          {folders.map((item) => <option key={item}>{item}</option>)}
        </select>
        <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} aria-label="Tag filter" className="rounded-lg border border-border-subtle bg-card px-2 py-1.5 text-[10px] text-cream">
          {allTags.map((item) => <option key={item}>{item}</option>)}
        </select>
        <button type="button" onClick={() => void load()} className="rounded-lg bg-white/8 px-3 py-1.5 text-[10px] font-semibold text-muted">রিফ্রেশ</button>
      </div>

      {error && <p role="alert" className="mx-3 mt-2 rounded-xl bg-red-500/10 p-2.5 text-[11px] text-red-300">{error}</p>}

      <div className="min-h-0 flex-1 overflow-y-auto p-3 pb-28">
        {loading ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, index) => <div key={index} className="aspect-[4/5] animate-pulse rounded-xl bg-white/[0.05]" />)}
          </div>
        ) : visible.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border-subtle p-8 text-center">
            <p className="text-sm font-semibold">{project.readonly ? 'Legacy collection খালি।' : 'এই Project-এ এখনো asset নেই।'}</p>
            {!project.readonly && <p className="mt-1 text-[11px] text-muted">নতুন Studio job এই project-এ auto-link হবে, অথবা Legacy থেকে যোগ করুন।</p>}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5">
            {visible.map((asset) => (
              <button key={asset.id} type="button" onClick={() => setSelected(asset)} className="overflow-hidden rounded-xl border border-border-subtle bg-card text-left transition hover:border-[#E07A5F]/60">
                <div className="aspect-[4/5] overflow-hidden"><AssetPreview asset={asset} /></div>
                <div className="space-y-1 p-2">
                  <p className="line-clamp-2 text-[10px] font-semibold text-cream">{asset.title ?? 'Untitled asset'}</p>
                  <div className="flex items-center justify-between gap-1 text-[9px] text-muted">
                    <span>{asset.folder}</span>
                    <span>{statusLabel(asset.status)}</span>
                  </div>
                  {asset.tags.length > 0 && <p className="truncate text-[8px] text-[#E07A5F]">#{asset.tags.map((tag) => tag.name).join(' #')}</p>}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div onClick={() => setSelected(null)} className="fixed inset-0 z-[75] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4">
          <div onClick={(event) => event.stopPropagation()} className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border-subtle bg-card p-4 sm:rounded-3xl">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="truncate text-sm font-bold">{selected.title ?? 'Asset detail'}</h3>
                <p className="text-[9px] text-muted">Created by {selected.createdById} · {new Date(selected.createdAt).toLocaleString('bn-BD')}</p>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-muted">✕</button>
            </div>

            <div className="mt-3 aspect-video max-h-72 overflow-hidden rounded-xl bg-black/40">
              <AssetPreview asset={selected} />
            </div>

            {!project.readonly && (
              <div className="mt-4 grid gap-3 rounded-xl border border-border-subtle bg-bg-1/70 p-3 sm:grid-cols-2">
                <label className="space-y-1 text-[10px] font-semibold text-muted">
                  Folder
                  <input value={folder} onChange={(event) => setFolder(event.target.value)} className="w-full rounded-lg border border-border-subtle bg-card px-2.5 py-2 text-[11px] text-cream" />
                </label>
                <label className="space-y-1 text-[10px] font-semibold text-muted">
                  Tags (comma)
                  <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="approved, eid, hero" className="w-full rounded-lg border border-border-subtle bg-card px-2.5 py-2 text-[11px] text-cream" />
                </label>
                <button type="button" disabled={saving} onClick={() => void saveMetadata()} className="rounded-lg bg-[#E07A5F] px-3 py-2 text-[11px] font-bold text-white disabled:opacity-50 sm:col-span-2">
                  {saving ? 'সেভ হচ্ছে…' : 'Folder ও tag সেভ'}
                </button>
              </div>
            )}

            {!project.readonly && project.brandProfileId && (
              <>
                <ReviewPanel
                  assetId={selected.id}
                  brandProfileId={project.brandProfileId}
                />
                <PublishPanel
                  assetId={selected.id}
                  brandProfileId={project.brandProfileId}
                  assetTitle={selected.title}
                />
                <PerformanceView
                  brandProfileId={project.brandProfileId}
                  projectId={project.id}
                  assetId={selected.id}
                />
              </>
            )}

            <div className="mt-4">
              <h4 className="text-[11px] font-bold">Version history & lineage</h4>
              <div className="mt-2 space-y-2">
                {selected.versions.map((version) => (
                  <div key={version.id} className="rounded-xl border border-border-subtle bg-bg-1/70 p-3">
                    <div className="flex items-center justify-between text-[10px]">
                      <span className="font-bold text-cream">Version {version.version}</span>
                      <span className="text-muted">{new Date(version.createdAt).toLocaleString('bn-BD')}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[9px] text-muted">
                      <span>Recipe</span><span className="text-cream">{version.recipeName ? `${version.recipeName} · v${version.recipeVersion}` : 'Legacy / none'}</span>
                      <span>Provider / engine</span><span className="text-cream">{version.provider ?? '—'} / {version.engine ?? '—'}</span>
                      <span>Job</span><span className="truncate font-mono text-cream">{version.jobId ?? '—'}</span>
                      <span>Cost</span><span className="text-cream">৳{version.costBdt}{version.costUsd !== null ? ` · $${version.costUsd.toFixed(4)}` : ''}</span>
                      <span>QC</span><span className="text-cream">{version.qc ? JSON.stringify(version.qc) : 'Not recorded'}</span>
                    </div>
                    {version.sources.length > 0 && (
                      <div className="mt-2 border-t border-border-subtle pt-2 text-[9px] text-muted">
                        Source: {version.sources.map((source) => source.title ?? source.pendingActionId ?? source.id).join(' · ')}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {legacyOpen && (
        <div onClick={() => setLegacyOpen(false)} className="fixed inset-0 z-[78] flex items-end justify-center bg-black/80 backdrop-blur-sm sm:items-center sm:p-4">
          <div onClick={(event) => event.stopPropagation()} className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-border-subtle bg-card p-4 sm:rounded-3xl">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold">Legacy থেকে asset যোগ</h3>
                <p className="text-[10px] text-muted">Original job/data অক্ষত থাকবে; project record ও version snapshot তৈরি হবে।</p>
              </div>
              <button type="button" onClick={() => setLegacyOpen(false)} className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-muted">✕</button>
            </div>
            {legacyLoading ? (
              <p className="py-10 text-center text-[11px] text-muted">Legacy লোড হচ্ছে…</p>
            ) : (
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
                {legacyAssets.map((asset) => (
                  <div key={asset.id} className="overflow-hidden rounded-xl border border-border-subtle bg-bg-1">
                    <div className="aspect-[4/5]"><AssetPreview asset={asset} /></div>
                    <div className="p-2">
                      <p className="line-clamp-2 text-[9px] font-semibold">{asset.title ?? 'Legacy asset'}</p>
                      <button type="button" disabled={attaching !== null} onClick={() => void importLegacy(asset)} className="mt-2 w-full rounded-lg bg-[#E07A5F] py-1.5 text-[9px] font-bold text-white disabled:opacity-40">
                        {attaching === asset.id ? 'যোগ হচ্ছে…' : 'এই Project-এ যোগ'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
