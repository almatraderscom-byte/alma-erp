'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  createStudioBrandRecipe,
  fetchBrandRecipes,
  updateStudioBrandRecipe,
} from '@/agent/components/creative-studio/studio-api'
import type {
  StudioBrandRecipe,
  StudioProjectSummary,
} from '@/lib/creative-studio/project-contract'

type Draft = {
  name: string
  sceneSubset: string
  modelRoles: string[]
  finishTheme: string
  captionTone: string
  aspectPack: string[]
  musicVibe: string
  qcLevel: 'off' | 'normal' | 'strict'
  spendCeilingBdt: string
}

const EMPTY_DRAFT: Draft = {
  name: '',
  sceneSubset: '',
  modelRoles: ['single'],
  finishTheme: 'default',
  captionTone: 'premium Bangla',
  aspectPack: ['4:5'],
  musicVibe: 'premium',
  qcLevel: 'strict',
  spendCeilingBdt: '0',
}

function draftFromRecipe(recipe: StudioBrandRecipe): Draft {
  return {
    name: recipe.name,
    sceneSubset: recipe.sceneSubset.join(', '),
    modelRoles: recipe.modelRoles,
    finishTheme: recipe.finishTheme,
    captionTone: recipe.captionTone,
    aspectPack: recipe.aspectPack,
    musicVibe: recipe.musicVibe,
    qcLevel: recipe.qcLevel,
    spendCeilingBdt: String(recipe.spendCeilingBdt),
  }
}

function ToggleGroup({
  values,
  selected,
  onChange,
  disabled,
}: {
  values: Array<{ id: string; label: string }>
  selected: string[]
  onChange: (next: string[]) => void
  disabled: boolean
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => {
        const active = selected.includes(value.id)
        return (
          <button
            key={value.id}
            type="button"
            disabled={disabled}
            aria-pressed={active}
            onClick={() => onChange(active ? selected.filter((item) => item !== value.id) : [...selected, value.id])}
            className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${
              active ? 'bg-[#E07A5F] text-white' : 'bg-white/8 text-muted'
            } disabled:opacity-50`}
          >
            {value.label}
          </button>
        )
      })}
    </div>
  )
}

export function BrandRecipeEditor({
  open,
  project,
  onClose,
  onSelect,
}: {
  open: boolean
  project: StudioProjectSummary
  onClose: () => void
  onSelect: (recipe: StudioBrandRecipe) => Promise<void> | void
}) {
  const [recipes, setRecipes] = useState<StudioBrandRecipe[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selected = useMemo(
    () => recipes.find((recipe) => recipe.id === selectedId) ?? null,
    [recipes, selectedId],
  )
  const locked = Boolean(selected?.locked)

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setError(null)
    void fetchBrandRecipes(project.brandProfileId)
      .then((rows) => {
        setRecipes(rows)
        const initial = rows.find((row) => row.id === project.currentRecipeId) ?? rows[0] ?? null
        setSelectedId(initial?.id ?? null)
        setDraft(initial ? draftFromRecipe(initial) : EMPTY_DRAFT)
      })
      .catch((reason) => setError(reason instanceof Error ? reason.message : 'Recipe লোড করা যায়নি।'))
      .finally(() => setLoading(false))
  }, [open, project.brandProfileId, project.currentRecipeId])

  if (!open) return null

  const payload = {
    brandProfileId: project.brandProfileId,
    brandName: 'ALMA Lifestyle',
    name: draft.name,
    sceneSubset: draft.sceneSubset,
    modelRoles: draft.modelRoles,
    finishTheme: draft.finishTheme,
    captionTone: draft.captionTone,
    aspectPack: draft.aspectPack,
    musicVibe: draft.musicVibe,
    qcLevel: draft.qcLevel,
    spendCeilingBdt: Number(draft.spendCeilingBdt || 0),
  }

  const replaceRecipe = (recipe: StudioBrandRecipe) => {
    setRecipes((current) => [recipe, ...current.filter((item) => item.id !== recipe.id)])
    setSelectedId(recipe.id)
    setDraft(draftFromRecipe(recipe))
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const recipe = selected
        ? await updateStudioBrandRecipe(selected.id, payload)
        : await createStudioBrandRecipe(payload)
      replaceRecipe(recipe)
      await onSelect(recipe)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Recipe সেভ করা যায়নি।')
    } finally {
      setBusy(false)
    }
  }

  const act = async (action: 'lock' | 'new_version') => {
    if (!selected) return
    if (action === 'lock' && !window.confirm('এই recipe version lock করবেন? Lock হলে এটি আর edit হবে না।')) return
    setBusy(true)
    setError(null)
    try {
      const recipe = await updateStudioBrandRecipe(selected.id, { action })
      replaceRecipe(recipe)
      await onSelect(recipe)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Recipe action সম্পন্ন হয়নি।')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Brand Recipe editor"
      onClick={onClose}
      className="fixed inset-0 z-[70] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border-subtle bg-card p-4 shadow-2xl sm:rounded-3xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-cream">Brand Recipe</h2>
            <p className="text-[11px] text-muted">Versioned · owner lock · প্রতি asset-এ snapshot থাকবে</p>
          </div>
          <button type="button" onClick={onClose} aria-label="বন্ধ করুন" className="grid h-8 w-8 place-items-center rounded-full bg-white/10 text-muted">✕</button>
        </div>

        {error && <p role="alert" className="mt-3 rounded-xl bg-red-500/10 p-2.5 text-[11px] text-red-300">{error}</p>}
        {loading ? (
          <p className="py-10 text-center text-[11px] text-muted">Recipe লোড হচ্ছে…</p>
        ) : (
          <>
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              <button
                type="button"
                onClick={() => {
                  setSelectedId(null)
                  setDraft(EMPTY_DRAFT)
                }}
                className={`shrink-0 rounded-xl px-3 py-2 text-[11px] font-bold ${selectedId === null ? 'bg-[#E07A5F] text-white' : 'bg-white/8 text-muted'}`}
              >
                + নতুন Recipe
              </button>
              {recipes.map((recipe) => (
                <button
                  key={recipe.id}
                  type="button"
                  onClick={() => {
                    setSelectedId(recipe.id)
                    setDraft(draftFromRecipe(recipe))
                  }}
                  className={`shrink-0 rounded-xl px-3 py-2 text-left text-[11px] ${
                    selectedId === recipe.id ? 'bg-white/15 text-cream ring-1 ring-[#E07A5F]' : 'bg-white/8 text-muted'
                  }`}
                >
                  <span className="block font-bold">{recipe.name} · v{recipe.version}</span>
                  <span>{recipe.locked ? '🔒 Locked' : 'Draft'}</span>
                </button>
              ))}
            </div>

            {selected?.locked && (
              <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-500/[0.08] px-3 py-2 text-[11px] text-emerald-300">
                🔒 এই version owner-locked। পরিবর্তন করতে “নতুন version” তৈরি করুন।
              </div>
            )}

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-[11px] font-semibold text-muted">
                Recipe নাম
                <input
                  disabled={locked}
                  value={draft.name}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                  className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50"
                />
              </label>
              <label className="space-y-1 text-[11px] font-semibold text-muted">
                Scene subset
                <input
                  disabled={locked}
                  value={draft.sceneSubset}
                  onChange={(event) => setDraft({ ...draft, sceneSubset: event.target.value })}
                  placeholder="warm studio, rooftop, festive home"
                  className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50"
                />
              </label>

              <div className="space-y-1.5 text-[11px] font-semibold text-muted">
                Model roles
                <ToggleGroup
                  disabled={locked}
                  selected={draft.modelRoles}
                  onChange={(modelRoles) => setDraft({ ...draft, modelRoles })}
                  values={[
                    { id: 'single', label: 'Single' },
                    { id: 'father', label: 'Father' },
                    { id: 'mother', label: 'Mother' },
                    { id: 'son', label: 'Son' },
                    { id: 'daughter', label: 'Daughter' },
                  ]}
                />
              </div>
              <div className="space-y-1.5 text-[11px] font-semibold text-muted">
                Aspect pack
                <ToggleGroup
                  disabled={locked}
                  selected={draft.aspectPack}
                  onChange={(aspectPack) => setDraft({ ...draft, aspectPack })}
                  values={['1:1', '4:5', '9:16', '16:9'].map((id) => ({ id, label: id }))}
                />
              </div>

              <label className="space-y-1 text-[11px] font-semibold text-muted">
                Finish theme
                <input disabled={locked} value={draft.finishTheme} onChange={(event) => setDraft({ ...draft, finishTheme: event.target.value })} className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50" />
              </label>
              <label className="space-y-1 text-[11px] font-semibold text-muted">
                Caption tone
                <input disabled={locked} value={draft.captionTone} onChange={(event) => setDraft({ ...draft, captionTone: event.target.value })} className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50" />
              </label>
              <label className="space-y-1 text-[11px] font-semibold text-muted">
                Music vibe
                <input disabled={locked} value={draft.musicVibe} onChange={(event) => setDraft({ ...draft, musicVibe: event.target.value })} className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50" />
              </label>
              <label className="space-y-1 text-[11px] font-semibold text-muted">
                QC level
                <select disabled={locked} value={draft.qcLevel} onChange={(event) => setDraft({ ...draft, qcLevel: event.target.value as Draft['qcLevel'] })} className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50">
                  <option value="strict">Strict</option>
                  <option value="normal">Normal</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label className="space-y-1 text-[11px] font-semibold text-muted sm:col-span-2">
                Spend ceiling (৳, whole taka)
                <input type="number" min="0" max="100000" disabled={locked} value={draft.spendCeilingBdt} onChange={(event) => setDraft({ ...draft, spendCeilingBdt: event.target.value })} className="w-full rounded-xl border border-border-subtle bg-bg-1 px-3 py-2 text-[12px] text-cream disabled:opacity-50" />
              </label>
            </div>

            <div className="mt-5 flex flex-wrap gap-2">
              {!locked && (
                <button type="button" disabled={busy || draft.name.trim().length < 2} onClick={() => void save()} className="rounded-xl bg-[#E07A5F] px-4 py-2.5 text-[11px] font-bold text-white disabled:opacity-40">
                  {busy ? 'সেভ হচ্ছে…' : selected ? 'পরিবর্তন সেভ' : 'Recipe তৈরি'}
                </button>
              )}
              {selected && !selected.locked && (
                <button type="button" disabled={busy} onClick={() => void act('lock')} className="rounded-xl bg-emerald-500/20 px-4 py-2.5 text-[11px] font-bold text-emerald-300">
                  🔒 Owner lock
                </button>
              )}
              {selected?.locked && (
                <button type="button" disabled={busy} onClick={() => void act('new_version')} className="rounded-xl bg-white/10 px-4 py-2.5 text-[11px] font-bold text-cream">
                  নতুন version
                </button>
              )}
              {selected && (
                <button type="button" disabled={busy} onClick={() => void Promise.resolve(onSelect(selected)).then(onClose)} className="rounded-xl bg-white/10 px-4 py-2.5 text-[11px] font-bold text-cream">
                  এই প্রজেক্টে ব্যবহার
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
