'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  assignStudioRole,
  fetchStudioRoleSettings,
  removeStudioRole,
  updateStudioBrand,
  type StudioAccessRole,
  type StudioBrandProfile,
  type StudioRoleSettings,
} from '@/agent/components/creative-studio/studio-api'

const EMPTY_SETTINGS: StudioRoleSettings = { assignments: [], eligibleUsers: [] }

export function StudioRoleSettings({
  brand,
  onBrandsChange,
}: {
  brand: StudioBrandProfile | null
  onBrandsChange: (brands: StudioBrandProfile[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [settings, setSettings] = useState<StudioRoleSettings>(EMPTY_SETTINGS)
  const [userId, setUserId] = useState('')
  const [role, setRole] = useState<Exclude<StudioAccessRole, 'owner'>>('creator')
  const [threshold, setThreshold] = useState('0')
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setThreshold(String(brand?.approvalSpendThresholdBdt ?? 0))
    setOpen(false)
    setSettings(EMPTY_SETTINGS)
    setError(null)
  }, [brand?.brandProfileId, brand?.approvalSpendThresholdBdt])

  const availableUsers = useMemo(() => {
    const assigned = new Set(settings.assignments.map((item) => item.userId))
    return settings.eligibleUsers.filter((user) => !assigned.has(user.id))
  }, [settings])

  const load = async () => {
    if (!brand || brand.role !== 'owner') return
    setLoading(true)
    setError(null)
    try {
      const next = await fetchStudioRoleSettings(brand.brandProfileId)
      setSettings(next)
      setUserId((current) => current || next.eligibleUsers[0]?.id || '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'দলের ভূমিকা লোড করা যায়নি।')
    } finally {
      setLoading(false)
    }
  }

  const show = () => {
    setOpen(true)
    void load()
  }

  const assign = async () => {
    if (!brand || !userId) return
    setSaving(true)
    setError(null)
    try {
      const next = await assignStudioRole({
        brandProfileId: brand.brandProfileId,
        userId,
        role,
      })
      setSettings(next)
      const assigned = new Set(next.assignments.map((item) => item.userId))
      setUserId(next.eligibleUsers.find((user) => !assigned.has(user.id))?.id ?? '')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ভূমিকা দেওয়া যায়নি।')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (targetUserId: string) => {
    if (!brand) return
    setSaving(true)
    setError(null)
    try {
      setSettings(await removeStudioRole({
        brandProfileId: brand.brandProfileId,
        userId: targetUserId,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'ভূমিকা সরানো যায়নি।')
    } finally {
      setSaving(false)
    }
  }

  const saveThreshold = async () => {
    if (!brand) return
    const amount = Number(threshold)
    if (!Number.isInteger(amount) || amount < 0) {
      setError('খরচের সীমা পূর্ণ টাকায় লিখুন।')
      return
    }
    setSaving(true)
    setError(null)
    try {
      onBrandsChange(await updateStudioBrand({
        brandProfileId: brand.brandProfileId,
        approvalSpendThresholdBdt: amount,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'খরচের সীমা সেভ করা যায়নি।')
    } finally {
      setSaving(false)
    }
  }

  if (!brand || brand.role !== 'owner') return null

  return (
    <>
      <button
        type="button"
        onClick={show}
        className="rounded-xl bg-white/10 px-2.5 py-1.5 text-[11px] font-bold text-muted transition hover:text-cream"
      >
        দল ও অনুমতি
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[95] flex items-end justify-center bg-black/75 backdrop-blur-sm sm:items-center sm:p-4"
          onClick={() => setOpen(false)}
        >
          <section
            aria-label={`${brand.name} দলের অনুমতি`}
            onClick={(event) => event.stopPropagation()}
            className="max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-t-3xl border border-border-subtle bg-card p-4 text-cream sm:rounded-3xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-sm font-extrabold">{brand.name} · দল ও অনুমতি</h2>
                <p className="mt-1 text-[11px] text-muted">
                  মালিক অনুমোদন দেবেন; নির্মাতা খসড়া/সংশোধন করবেন; পর্যালোচক মন্তব্য ও পরিবর্তন চাইবেন।
                </p>
              </div>
              <button
                type="button"
                aria-label="বন্ধ করুন"
                onClick={() => setOpen(false)}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-muted"
              >
                ✕
              </button>
            </div>

            {error && (
              <p role="alert" className="mt-3 rounded-xl bg-red-500/10 p-2.5 text-[11px] text-red-300">
                {error}
              </p>
            )}

            <div className="mt-4 rounded-2xl border border-border-subtle bg-bg-1/70 p-3">
              <label className="text-[11px] font-bold text-muted">
                মালিকের অনুমোদন ছাড়া সর্বোচ্চ খরচ
                <div className="mt-1 flex gap-2">
                  <div className="flex min-w-0 flex-1 items-center rounded-xl border border-border-subtle bg-card px-3">
                    <span className="text-xs text-muted">৳</span>
                    <input
                      inputMode="numeric"
                      min={0}
                      step={1}
                      value={threshold}
                      onChange={(event) => setThreshold(event.target.value)}
                      className="min-w-0 flex-1 bg-transparent px-2 py-2 text-xs text-cream outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void saveThreshold()}
                    className="rounded-xl bg-[#E07A5F] px-4 text-[11px] font-bold text-white disabled:opacity-50"
                  >
                    সেভ
                  </button>
                </div>
              </label>
              <p className="mt-1.5 text-[11px] text-muted">
                এর বেশি খরচের কাজ কেবল মালিক অনুমোদন করতে পারবেন। ০ মানে সব খরচে মালিকের অনুমোদন লাগবে।
              </p>
            </div>

            <div className="mt-4">
              <h3 className="text-[11px] font-bold">বর্তমান দল</h3>
              <div className="mt-2 space-y-2">
                <div className="flex items-center justify-between rounded-xl border border-[#81B29A]/25 bg-[#81B29A]/10 p-3">
                  <div>
                    <p className="text-[11px] font-bold">আপনি</p>
                    <p className="text-[11px] text-muted">ব্র্যান্ড মালিক · পূর্ণ অনুমতি</p>
                  </div>
                  <span className="rounded-full bg-[#81B29A]/20 px-2 py-1 text-[11px] font-bold text-[#9fd6bd]">মালিক</span>
                </div>
                {loading ? (
                  <div className="h-16 animate-pulse rounded-xl bg-white/[0.05]" />
                ) : settings.assignments.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-border-subtle p-4 text-center text-[11px] text-muted">
                    এখনো কাউকে ভূমিকা দেওয়া হয়নি। মালিক-শুধু আচরণ সক্রিয় আছে।
                  </p>
                ) : settings.assignments.map((assignment) => (
                  <div key={assignment.id} className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-bg-1/60 p-3">
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-bold">{assignment.userName}</p>
                      <p className="truncate text-[11px] text-muted">
                        {assignment.userEmail ?? assignment.erpRole} · {assignment.role === 'creator' ? 'নির্মাতা' : 'পর্যালোচক'}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => void remove(assignment.userId)}
                      className="rounded-lg bg-red-500/10 px-2.5 py-1.5 text-[11px] font-bold text-red-300 disabled:opacity-40"
                    >
                      সরান
                    </button>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 rounded-2xl border border-border-subtle bg-bg-1/70 p-3">
              <h3 className="text-[11px] font-bold">নতুন ভূমিকা দিন</h3>
              <div className="mt-2 grid gap-2 sm:grid-cols-[1fr_9rem_auto]">
                <select
                  value={userId}
                  onChange={(event) => setUserId(event.target.value)}
                  className="min-w-0 rounded-xl border border-border-subtle bg-card px-2.5 py-2 text-[11px] text-cream"
                >
                  <option value="">ব্যবহারকারী বাছুন</option>
                  {availableUsers.map((user) => (
                    <option key={user.id} value={user.id}>{user.name} · {user.erpRole}</option>
                  ))}
                </select>
                <select
                  value={role}
                  onChange={(event) => setRole(event.target.value as Exclude<StudioAccessRole, 'owner'>)}
                  className="rounded-xl border border-border-subtle bg-card px-2.5 py-2 text-[11px] text-cream"
                >
                  <option value="creator">নির্মাতা</option>
                  <option value="reviewer">পর্যালোচক</option>
                </select>
                <button
                  type="button"
                  disabled={saving || !userId}
                  onClick={() => void assign()}
                  className="rounded-xl bg-[#E07A5F] px-4 py-2 text-[11px] font-bold text-white disabled:opacity-40"
                >
                  ভূমিকা দিন
                </button>
              </div>
            </div>
          </section>
        </div>
      )}
    </>
  )
}
