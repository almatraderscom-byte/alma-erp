'use client'

/**
 * CameraListenCard — owner on/off switch for the entrance-camera VOICE listener.
 *
 * Separate from the entrance WATCH (vision) card. Backs /api/assistant/camera-control
 * (agent_kv_settings), so a flip takes effect on the next audio chunk — no redeploy.
 * Default is OFF after the runaway-cost fix; the owner turns it on here when he
 * wants staff to be able to call him by saying the wake word to the camera.
 */
import { useCallback, useEffect, useState } from 'react'

interface CameraListenStatus {
  enabled: boolean
  dailyCap: number
  usedToday: number
  wakeWords: string
  echoGuardSec: number
}

const cardCls = 'rounded-2xl border border-white/10 bg-white/5 p-4'

export default function CameraListenCard() {
  const [status, setStatus] = useState<CameraListenStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/camera-control')
      if (res.ok) setStatus((await res.json()) as CameraListenStatus)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  async function patch(body: { enabled?: boolean; dailyCap?: number }) {
    setSaving(true)
    setMsg('')
    try {
      const res = await fetch('/api/assistant/camera-control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = (await res.json()) as CameraListenStatus & { error?: string }
      if (res.ok) {
        setStatus(data)
        setMsg(body.enabled === true ? 'চালু হলো' : body.enabled === false ? 'বন্ধ হলো' : 'সেভ হয়েছে')
      } else {
        setMsg(data.error ?? 'সেভ হয়নি')
      }
    } catch {
      setMsg('নেটওয়ার্ক সমস্যা')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <section className={cardCls}><div className="text-sm text-cream/60">লোড হচ্ছে…</div></section>
  if (!status) return <section className={cardCls}><div className="text-sm text-cream/60">সেটিংস লোড হয়নি</div></section>

  return (
    <section className={cardCls} data-testid="camera-listen-settings">
      <h2 className="mb-1 text-base font-semibold text-cream">🎤 এন্ট্রান্স ক্যামেরা — কথা শোনা</h2>
      <p className="mb-3 text-xs text-cream/60">
        স্টাফ ক্যামেরার সামনে এসে <b>“আলমা শোনো”</b> বললে তবেই আপনার কাছে মেসেজ যাবে। বন্ধ থাকলে ক্যামেরা কিছুই শোনে না, কোনো খরচ হয় না।
      </p>

      <div className="flex items-center justify-between rounded-xl bg-black/30 px-3 py-2">
        <span className="text-sm text-cream/90">{status.enabled ? 'চালু' : 'বন্ধ'}</span>
        <button
          type="button"
          disabled={saving}
          onClick={() => void patch({ enabled: !status.enabled })}
          data-testid="camera-listen-toggle"
          aria-pressed={status.enabled}
          className={`relative h-7 w-12 rounded-full transition-colors disabled:opacity-50 ${status.enabled ? 'bg-coral' : 'bg-white/20'}`}
        >
          <span className={`absolute top-1 h-5 w-5 rounded-full bg-white transition-all ${status.enabled ? 'left-6' : 'left-1'}`} />
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-cream/70">
        <div className="rounded-xl bg-black/20 px-3 py-2">
          দৈনিক সীমা<div className="text-sm text-cream/90">{status.dailyCap} বার</div>
        </div>
        <div className="rounded-xl bg-black/20 px-3 py-2">
          আজ ব্যবহার<div className="text-sm text-cream/90">{status.usedToday} বার</div>
        </div>
      </div>

      {msg ? <div className="mt-2 text-xs text-cream/70">{msg}</div> : null}
    </section>
  )
}
