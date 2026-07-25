'use client'

import {
  deleteGarmentCache,
  fetchGoldenEval,
  fetchStudioConfig,
  fetchStudioHealth,
  fetchStudioRetention,
  fetchStudioSettings,
  runGoldenEvalNow,
  saveStudioRetention,
  saveStudioSettings,
  setEngineKill,
  type GoldenEvalSummary,
  type StudioConfig,
  type StudioHealth,
  type StudioRetentionDashboard,
  type StudioSettings,
} from '@/agent/components/creative-studio/studio-api'
import { type StudioEngineId } from '@/lib/creative-studio/provider-registry'
import { cn } from '@/lib/utils'
import { useEffect, useState } from 'react'
import { toast } from 'react-hot-toast'

export function StudioSettingsView() {
  const [settings, setSettings] = useState<StudioSettings | null>(null)
  const [config, setConfig] = useState<StudioConfig | null>(null)
  // CS10 — golden evaluation summary + run trigger
  const [goldenEval, setGoldenEval] = useState<GoldenEvalSummary | null>(null)
  const [evalRunning, setEvalRunning] = useState(false)
  // CS12 — engine health + kill switches
  const [health, setHealth] = useState<StudioHealth | null>(null)
  // CSE7 — durable Drive receipt before any original can be deleted.
  const [retention, setRetention] = useState<StudioRetentionDashboard | null>(null)
  const [retentionSaving, setRetentionSaving] = useState(false)
  useEffect(() => {
    void fetchStudioSettings()
      .then(setSettings)
      .catch(() => {})
    void fetchStudioConfig()
      .then(setConfig)
      .catch(() => {})
    void fetchGoldenEval()
      .then(setGoldenEval)
      .catch(() => {})
    void fetchStudioHealth()
      .then(setHealth)
      .catch(() => {})
    void fetchStudioRetention()
      .then(setRetention)
      .catch(() => {})
  }, [])
  if (!settings) return null

  const saveFalFlag = (
    patch: Partial<Pick<StudioSettings, 'falEnabled' | 'idmVtonEnabled' | 'fluxFillEnabled' | 'xaiEnabled'>> & {
      singleVtonDefault?: StudioEngineId
    },
  ) => {
    setSettings({ ...settings, ...patch })
    void saveStudioSettings(patch)
      .then(() => toast.success('সেভ হয়েছে'))
      .catch(() => toast.error('হয়নি'))
  }
  return (
    <div className="mt-3 space-y-2.5 st-card p-3">
      <p className="text-[12px] font-bold text-cream">⚙️ স্টুডিও সেটিংস</p>
      {/* CS8 — Preview vs Production: bounded spend shown up front */}
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">পাইপলাইন মোড</span>
        <select
          value={settings.pipelineMode}
          onChange={(e) => {
            const pipelineMode = e.target.value as StudioSettings['pipelineMode']
            setSettings({ ...settings, pipelineMode })
            void saveStudioSettings({ pipelineMode })
              .then(() => toast.success('সেভ হয়েছে — পরের রান থেকে কার্যকর'))
              .catch(() => toast.error('হয়নি'))
          }}
          className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
        >
          <option value="preview">প্রিভিউ — ১টি সাশ্রয়ী রান</option>
          <option value="production">প্রোডাকশন — কড়া QC · সর্বোচ্চ ৩ পেইড রান</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">ছবির QC (মান যাচাই)</span>
        <select
          value={settings.qcLevel}
          onChange={(e) => {
            const qcLevel = e.target.value as StudioSettings['qcLevel']
            setSettings({ ...settings, qcLevel })
            void saveStudioSettings({ qcLevel })
              .then(() => toast.success('সেভ হয়েছে'))
              .catch(() => toast.error('হয়নি'))
          }}
          className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
        >
          <option value="off">বন্ধ</option>
          <option value="normal">নরমাল</option>
          <option value="strict">কড়া</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">ইমেজ ইঞ্জিন</span>
        <select
          value={settings.imageEngine}
          onChange={(e) => {
            const imageEngine = e.target.value as StudioSettings['imageEngine']
            setSettings({ ...settings, imageEngine })
            void saveStudioSettings({ imageEngine })
              .then(() => toast.success('সেভ হয়েছে — পরের রেন্ডার থেকে কার্যকর'))
              .catch(() => toast.error('হয়নি'))
          }}
          className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
        >
          <option value="gemini">Nano Banana (ফটোরিয়াল · মুখ/মডেল সেরা)</option>
          <option value="gpt">GPT Image 2 (লেখা/পোস্টার সেরা · দ্রুত)</option>
          <option value="seedream">Seedream 5.0 Pro (2K ডিটেইল · নতুন)</option>
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted">কাজ শেষ হলে Telegram-এ জানাও</span>
        <input
          type="checkbox"
          checked={settings.notifyOnDone}
          onChange={(e) => {
            const notifyOnDone = e.target.checked
            setSettings({ ...settings, notifyOnDone })
            void saveStudioSettings({ notifyOnDone })
              .then(() => toast.success('সেভ হয়েছে'))
              .catch(() => toast.error('হয়নি'))
          }}
          className="h-4 w-4 accent-[#E07A5F]"
        />
      </label>

      {/* CS5 — Fal engine foundation: owner flags only. Engines become runnable
          in CS6 (try-on) / CS7 (FLUX Fill); flipping these today changes nothing
          in the Run tab, so the current defaults stay exactly as they were. */}
      <div className="border-t border-border-subtle pt-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-bold text-cream">🧪 Fal ইঞ্জিন (নতুন — সামনের ফেজে চালু)</p>
          {config && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[9px] font-semibold',
                config.falConfigured ? 'bg-[#81B29A]/15 text-[#2d6a4f]' : 'bg-amber-100 text-amber-800',
              )}
            >
              {config.falConfigured ? 'FAL_KEY আছে' : 'FAL_KEY নেই'}
            </span>
          )}
        </div>
        <p className="mb-2 mt-0.5 text-[10px] text-muted">
          এখন শুধু প্রস্তুতি — Try-On ইঞ্জিন বাছাই (CS6) ও মাস্ক-এডিট (CS7) এলে এগুলো কাজে লাগবে। আজকের রেন্ডার আগের মতোই চলবে।
        </p>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">Fal ইঞ্জিন চালু (FASHN v1.6 · কমার্শিয়াল)</span>
          <input
            type="checkbox"
            checked={settings.falEnabled}
            onChange={(e) => saveFalFlag({ falEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">
            IDM-VTON{' '}
            <span className="rounded bg-amber-100 px-1 py-px text-[9px] font-bold text-amber-800">পরীক্ষামূলক · research-only</span>
          </span>
          <input
            type="checkbox"
            checked={settings.idmVtonEnabled}
            onChange={(e) => saveFalFlag({ idmVtonEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">FLUX Fill (মাস্ক-করা জায়গা এডিট)</span>
          <input
            type="checkbox"
            checked={settings.fluxFillEnabled}
            onChange={(e) => saveFalFlag({ fluxFillEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        {/* CS13 — xAI Grok Imagine: generation + এডিট + মাল্টি-রেফারেন্স (সর্বোচ্চ ৩ ছবি) */}
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">
            Grok Imagine (xAI) — Generate + সব মোড
            {config && !config.xaiConfigured && (
              <span className="ml-1 rounded bg-amber-100 px-1 py-px text-[9px] font-bold text-amber-800">XAI_API_KEY নেই</span>
            )}
          </span>
          <input
            type="checkbox"
            checked={settings.xaiEnabled}
            onChange={(e) => saveFalFlag({ xaiEnabled: e.target.checked })}
            className="h-4 w-4 accent-[#E07A5F]"
          />
        </label>
        <label className="flex items-center justify-between gap-2 py-1">
          <span className="text-[11px] text-muted">ডিফল্ট ইঞ্জিন — সব রানে (সিঙ্গেল + ফ্যামিলি)</span>
          <select
            value={settings.singleVtonDefault}
            onChange={(e) =>
              saveFalFlag({
                singleVtonDefault: e.target.value as StudioEngineId,
              })
            }
            className="rounded-lg border border-border-subtle bg-bg-1 px-2 py-1 text-[11px] text-cream"
          >
            <option value="fal_fashn_v16">Fal FASHN v1.6 · কমার্শিয়াল</option>
            <option value="fashn">FASHN Pro (direct)</option>
            <option value="fal_idm_vton">IDM-VTON (পরীক্ষামূলক · শুধু সিঙ্গেল)</option>
            <option value="xai_imagine">Grok Imagine (xAI) — Auto সোলো শটেও</option>
          </select>
        </label>
      </div>
      {/* CS12 — engine health, kill switches, worker heartbeat, balances */}
      {health && (
        <div className="border-t border-border-subtle pt-2.5">
          <div className="flex items-center justify-between">
            <p className="text-[12px] font-bold text-cream">🚦 ইঞ্জিন হেলথ (শেষ {health.windowDays} দিন)</p>
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[9px] font-semibold',
                health.worker.state === 'healthy' && 'bg-[#81B29A]/15 text-[#2d6a4f]',
                health.worker.state === 'delayed' && 'bg-amber-100 text-amber-800',
                health.worker.state === 'offline' && 'bg-red-100 text-red-700',
                health.worker.state === 'unknown' && 'bg-white/10 text-muted-hi',
              )}
            >
              Worker {health.worker.labelBn}
            </span>
          </div>
          <p className="mt-1 text-[9px] text-muted">
            Queue signal: {health.worker.lastSeenBn} · Turn consumer: {health.turnConsumer.labelBn} ({health.turnConsumer.lastSeenBn})
          </p>
          <div className="mt-1.5 space-y-1">
            {health.engines.slice(0, 6).map((e) => (
              <div key={e.engine} className="flex items-center justify-between gap-2">
                <p className="min-w-0 flex-1 truncate text-[10px] leading-snug text-muted-hi">
                  {e.labelBn}: {e.jobs} কাজ · ব্যর্থ {e.errorRatePct}%{e.qcPassRatePct !== null ? ` · QC পাস ${e.qcPassRatePct}%` : ''}
                  {e.p95LatencyMs ? ` · p95 ${Math.round(e.p95LatencyMs / 1000)}s` : ''} · $${e.spendUsd}
                </p>
                <label className="flex shrink-0 items-center gap-1 text-[9px] text-muted">
                  বন্ধ
                  <input
                    type="checkbox"
                    checked={Boolean(health.kills[e.engine])}
                    onChange={(ev) => {
                      const killed = ev.target.checked
                      setHealth({
                        ...health,
                        kills: { ...health.kills, [e.engine]: killed },
                      })
                      void setEngineKill(e.engine, killed)
                        .then(() => toast.success(killed ? e.labelBn + ' বন্ধ (kill switch)' : e.labelBn + ' চালু'))
                        .catch(() => toast.error('হয়নি'))
                    }}
                    className="h-3.5 w-3.5 accent-red-500"
                  />
                </label>
              </div>
            ))}
          </div>
          {health.balances.length > 0 && (
            <p className="mt-1.5 text-[10px] text-muted">
              ব্যালেন্স: {health.balances.map((b) => b.label + ' ' + (b.balanceUsd !== null ? '$' + b.balanceUsd : '—')).join(' · ')}
            </p>
          )}
        </div>
      )}

      {retention && (
        <div className="border-t border-border-subtle pt-2.5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-[12px] font-bold text-cream">🗄️ Drive archive ও retention</p>
              <p className="mt-0.5 text-[9px] text-muted">
                Durable Drive verification ছাড়া original কখনো delete হবে না।
              </p>
            </div>
            <span className="rounded-full bg-[#81B29A]/10 px-2 py-0.5 text-[9px] text-[#a7d7bf]">
              {retention.stats.verifiedReceipts}/{retention.stats.totalReceipts} verified
            </span>
          </div>
          <div className="mt-2 space-y-2">
            <label className="flex items-center justify-between gap-2 text-[10px] text-muted">
              Drive archive চালু
              <input
                type="checkbox"
                checked={retention.policy.archiveEnabled}
                onChange={(event) => setRetention({
                  ...retention,
                  policy: { ...retention.policy, archiveEnabled: event.target.checked },
                })}
                className="h-4 w-4 accent-[#E07A5F]"
              />
            </label>
            <label className="flex items-center justify-between gap-2 text-[10px] text-muted">
              Verified copy-এর পর original cleanup
              <input
                type="checkbox"
                checked={retention.policy.deleteOriginalsEnabled}
                onChange={(event) => setRetention({
                  ...retention,
                  policy: { ...retention.policy, deleteOriginalsEnabled: event.target.checked },
                })}
                className="h-4 w-4 accent-[#E07A5F]"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-[9px] font-semibold text-muted">
                Retention দিন (7–3650)
                <input
                  type="number"
                  min={7}
                  max={3650}
                  value={retention.policy.retentionDays}
                  onChange={(event) => setRetention({
                    ...retention,
                    policy: {
                      ...retention.policy,
                      retentionDays: Number(event.target.value),
                    },
                  })}
                  className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[10px] text-cream"
                />
              </label>
              <label className="space-y-1 text-[9px] font-semibold text-muted">
                Verification grace ঘণ্টা
                <input
                  type="number"
                  min={1}
                  max={168}
                  value={retention.policy.verificationGraceHours}
                  onChange={(event) => setRetention({
                    ...retention,
                    policy: {
                      ...retention.policy,
                      verificationGraceHours: Number(event.target.value),
                    },
                  })}
                  className="w-full rounded-lg border border-border-subtle bg-bg-1 px-2 py-1.5 text-[10px] text-cream"
                />
              </label>
            </div>
            <p className="text-[9px] text-muted">
              Deleted {retention.stats.deletedOriginals} · failed {retention.stats.failedReceipts}
              {' '}· oldest unverified {retention.stats.oldestUnverifiedAgeHours}h
            </p>
            <button
              type="button"
              disabled={retentionSaving}
              onClick={() => {
                setRetentionSaving(true)
                void saveStudioRetention(retention.policy)
                  .then((result) => {
                    setRetention(result)
                    toast.success('Retention policy সেভ হয়েছে')
                  })
                  .catch((error) => toast.error(error instanceof Error ? error.message : 'হয়নি'))
                  .finally(() => setRetentionSaving(false))
              }}
              className="w-full rounded-lg bg-white/10 px-3 py-2 text-[10px] font-bold text-cream disabled:opacity-40"
            >
              {retentionSaving ? 'সেভ হচ্ছে…' : 'Archive policy সেভ'}
            </button>
          </div>
        </div>
      )}

      {/* CS10 — golden evaluation: measurable engine comparison, owner-triggered */}
      <div className="border-t border-border-subtle pt-2.5">
        <div className="flex items-center justify-between">
          <p className="text-[12px] font-bold text-cream">🏅 গোল্ডেন টেস্ট (ইঞ্জিন তুলনা)</p>
          <button
            type="button"
            disabled={evalRunning || !goldenEval?.cases?.length}
            onClick={() => {
              setEvalRunning(true)
              void runGoldenEvalNow()
                .then((r) => toast.success(`টেস্ট চলছে (${r.runId}) — আনুমানিক $${r.estimatedCostUsd} · কিছুক্ষণ পরে এখানে ফল আসবে`))
                .catch((e) => toast.error(e instanceof Error ? e.message : 'হয়নি'))
                .finally(() => setEvalRunning(false))
            }}
            className="rounded-full bg-[#E07A5F] px-3 py-1 text-[10px] font-bold text-white disabled:opacity-40"
          >
            {evalRunning ? 'পাঠানো হচ্ছে…' : 'টেস্ট চালাও'}
          </button>
        </div>
        <p className="mt-0.5 text-[10px] text-muted">
          {goldenEval?.cases?.length
            ? `${goldenEval.cases.length}টি গোল্ডেন কেস — ৩ ইঞ্জিনে একই ছবি চালিয়ে সংখ্যায় তুলনা`
            : 'গোল্ডেন কেস এখনো নেই — evaluations API দিয়ে case যোগ করুন'}
        </p>
        {goldenEval?.comparison && (
          <div className="mt-1.5 space-y-1">
            {goldenEval.comparison.rankings.map((r) => (
              <p key={r.engine} className="text-[10px] leading-snug text-muted-hi">
                {r.reasonBn}
              </p>
            ))}
            <p className="text-[10.5px] font-semibold text-cream">{goldenEval.comparison.verdictBn}</p>
          </div>
        )}
      </div>

      {settings.childGarments.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold text-muted">বাচ্চার গার্মেন্ট ক্যাশ (খারাপ হলে মুছুন — পরের রানে নতুন হবে)</p>
          <div className="flex flex-wrap gap-1.5">
            {settings.childGarments.map((g) => (
              <div key={g.key} className="relative">
                {g.url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.url} alt="" className="h-14 w-11 rounded-md object-cover ring-1 ring-white/15" />
                ) : (
                  <div className="grid h-14 w-11 place-items-center rounded-md bg-white/10 text-[9px] text-muted">{g.role}</div>
                )}
                <button
                  type="button"
                  aria-label="মুছুন"
                  onClick={() => {
                    void deleteGarmentCache(g.key)
                      .then(() =>
                        setSettings({
                          ...settings,
                          childGarments: settings.childGarments.filter((x) => x.key !== g.key),
                        }),
                      )
                      .catch(() => toast.error('হয়নি'))
                  }}
                  className="absolute -right-1 -top-1 grid h-4 w-4 place-items-center rounded-full bg-red-500 text-[9px] text-white"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
