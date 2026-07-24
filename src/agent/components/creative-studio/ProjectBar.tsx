'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { BrandRecipeEditor } from '@/agent/components/creative-studio/BrandRecipeEditor'
import { ProductPicker } from '@/agent/components/creative-studio/ProductPicker'
import {
  createStudioProject,
  fetchStudioProjects,
  setActiveStudioContentContext,
  updateStudioProject,
} from '@/agent/components/creative-studio/studio-api'
import type {
  StudioBrandRecipe,
  StudioProductOption,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'

const ACTIVE_PROJECT_KEY = 'alma-creative-studio-project'

export function ProjectBar({
  onProjectChange,
  onOpenLibrary,
}: {
  onProjectChange: (project: StudioProjectSummary | null) => void
  onOpenLibrary: (project: StudioProjectSummary) => void
}) {
  const [projects, setProjects] = useState<StudioProjectSummary[]>([])
  const [activeId, setActiveId] = useState('legacy')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [productOpen, setProductOpen] = useState(false)
  const [recipeOpen, setRecipeOpen] = useState(false)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [brandName, setBrandName] = useState('ALMA Lifestyle')
  const [busy, setBusy] = useState(false)

  const active = useMemo(
    () => projects.find((project) => project.id === activeId) ?? projects[0] ?? null,
    [activeId, projects],
  )

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await fetchStudioProjects()
      setProjects(rows)
      const stored = typeof window !== 'undefined' ? window.localStorage.getItem(ACTIVE_PROJECT_KEY) : null
      const next = rows.some((project) => project.id === stored)
        ? stored!
        : rows.find((project) => !project.readonly)?.id ?? 'legacy'
      setActiveId((current) => rows.some((project) => project.id === current) && current !== 'legacy' ? current : next)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Projects লোড করা যায়নি।')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!active) {
      setActiveStudioContentContext(null)
      onProjectChange(null)
      return
    }
    window.localStorage.setItem(ACTIVE_PROJECT_KEY, active.id)
    setActiveStudioContentContext(active.readonly
      ? null
      : {
          projectId: active.id,
          recipeId: active.currentRecipeId,
          folder: active.defaultFolder,
        })
    onProjectChange(active)
  }, [active, onProjectChange])

  const replaceProject = (project: StudioProjectSummary) => {
    setProjects((current) => current.map((item) => item.id === project.id ? project : item))
  }

  const create = async () => {
    if (name.trim().length < 2) return
    setBusy(true)
    setError(null)
    try {
      const project = await createStudioProject({
        name,
        description,
        brandName,
      })
      setProjects((current) => [current.find((item) => item.id === 'legacy')!, project, ...current.filter((item) => item.id !== 'legacy')].filter(Boolean))
      setActiveId(project.id)
      setCreateOpen(false)
      setName('')
      setDescription('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Project তৈরি করা যায়নি।')
    } finally {
      setBusy(false)
    }
  }

  const selectProduct = async (product: StudioProductOption) => {
    if (!active || active.readonly) return
    const project = await updateStudioProject(active.id, {
      productCode: product.code,
      productName: product.name,
      productPriceBdt: product.priceBdt,
      productSourceImage: product.sourceImage,
    })
    replaceProject(project)
  }

  const selectRecipe = async (recipe: StudioBrandRecipe) => {
    if (!active || active.readonly) return
    const project = await updateStudioProject(active.id, {
      brandProfileId: recipe.brandProfileId,
      currentRecipeId: recipe.id,
    })
    replaceProject(project)
  }

  return (
    <>
      <div className="shrink-0 border-b border-border-subtle bg-bg-1/90 px-3 py-2 backdrop-blur-md sm:px-4">
        <div className="flex items-center gap-2">
          <select
            aria-label="Creative project"
            value={active?.id ?? 'legacy'}
            disabled={loading}
            onChange={(event) => setActiveId(event.target.value)}
            className="min-w-0 flex-1 rounded-xl border border-border-subtle bg-card px-2.5 py-2 text-[11px] font-bold text-cream outline-none focus:border-[#E07A5F]"
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.readonly ? '🗃 ' : '📁 '}{project.name} · {project.assetCount}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setCreateOpen(true)} aria-label="নতুন প্রজেক্ট" className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-white/10 text-sm font-bold text-cream">
            +
          </button>
          {active && (
            <button type="button" onClick={() => onOpenLibrary(active)} className="shrink-0 rounded-xl bg-[#E07A5F]/15 px-3 py-2 text-[10px] font-bold text-[#E07A5F]">
              Assets
            </button>
          )}
        </div>

        {active && !active.readonly && (
          <div className="mt-2 flex min-w-0 items-center gap-2 overflow-x-auto">
            <button type="button" onClick={() => setProductOpen(true)} className="shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[9px] font-semibold text-muted">
              {active.product ? `📦 ${active.product.code} · ৳${active.product.priceBdt.toLocaleString('bn-BD')}` : '+ ERP প্রোডাক্ট'}
            </button>
            <button type="button" onClick={() => setRecipeOpen(true)} className="shrink-0 rounded-full bg-white/[0.06] px-2.5 py-1 text-[9px] font-semibold text-muted">
              {active.currentRecipe
                ? `${active.currentRecipe.locked ? '🔒' : '📝'} ${active.currentRecipe.name} v${active.currentRecipe.version}`
                : '+ Brand Recipe'}
            </button>
            <span className="truncate text-[9px] text-muted">Folder: {active.defaultFolder}</span>
          </div>
        )}
        {active?.readonly && (
          <p className="mt-1.5 text-[9px] text-muted">Legacy read-only · কোনো পুরোনো Creative হারাবে না</p>
        )}
        {error && <p role="alert" className="mt-1 text-[9px] text-red-300">{error}</p>}
      </div>

      {createOpen && (
        <div role="dialog" aria-modal="true" aria-label="নতুন Creative project" onClick={() => setCreateOpen(false)} className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4">
          <div onClick={(event) => event.stopPropagation()} className="w-full max-w-md rounded-t-3xl border border-border-subtle bg-card p-4 sm:rounded-3xl">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-cream">নতুন Project</h2>
              <button type="button" onClick={() => setCreateOpen(false)} className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-muted">✕</button>
            </div>
            <div className="mt-4 space-y-3">
              <label className="block space-y-1 text-[10px] font-semibold text-muted">
                Project নাম
                <input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="যেমন: Eid 2026 Launch" className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2.5 text-[12px] text-cream" />
              </label>
              <label className="block space-y-1 text-[10px] font-semibold text-muted">
                Brand
                <input value={brandName} onChange={(event) => setBrandName(event.target.value)} className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2.5 text-[12px] text-cream" />
              </label>
              <label className="block space-y-1 text-[10px] font-semibold text-muted">
                সংক্ষিপ্ত লক্ষ্য
                <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} className="w-full resize-none rounded-xl border border-border-subtle bg-bg-1 px-3 py-2.5 text-[12px] text-cream" />
              </label>
              <button type="button" disabled={busy || name.trim().length < 2} onClick={() => void create()} className="w-full rounded-xl bg-[#E07A5F] py-2.5 text-[12px] font-bold text-white disabled:opacity-40">
                {busy ? 'তৈরি হচ্ছে…' : 'Project তৈরি'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ProductPicker open={productOpen} onClose={() => setProductOpen(false)} onSelect={selectProduct} />
      {active && !active.readonly && (
        <BrandRecipeEditor open={recipeOpen} project={active} onClose={() => setRecipeOpen(false)} onSelect={selectRecipe} />
      )}
    </>
  )
}
