'use client'

/**
 * KnownPeopleManager — owner UI for the camera face registry + entrance watch.
 *
 * Three cards:
 *  1. এন্ট্রান্স ক্যামেরা — pick which Imou camera watches the entrance, on/off,
 *     active window, alert cooldown, and a live 🧪 টেস্ট button (captures a frame,
 *     runs identification, pushes the card to owner Telegram, shows result here).
 *  2. নতুন মানুষ যোগ — name + role + 1–3 reference photos (downscaled client-side
 *     so uploads stay small).
 *  3. তালিকা — registered people with thumbnail, role, active toggle, delete.
 */
import { useCallback, useEffect, useState } from 'react'

interface Person {
  id: string
  name: string
  role: string
  photoPaths: string[]
  active: boolean
}

interface Settings {
  enabled: boolean
  deviceId: string
  startHm: string
  endHm: string
  cooldownMin: number
}

interface Camera {
  deviceId: string
  channelId: string
  channelName: string
}

interface TestResult {
  ran: boolean
  error?: string
  peopleCount?: number
  identified?: string[]
  strangerPresent?: boolean
  hadReferences?: boolean
  summaryBn?: string
  telegramSent?: boolean
}

const ROLES: Array<{ value: string; label: string }> = [
  { value: 'owner', label: 'মালিক' },
  { value: 'staff', label: 'স্টাফ' },
  { value: 'family', label: 'পরিবার' },
  { value: 'other', label: 'অন্যান্য' },
]

/** Downscale to ≤1024px JPEG so a phone photo doesn't blow the request size. */
async function fileToSmallBase64(file: File): Promise<{ base64: string; mimeType: string }> {
  const dataUrl: string = await new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('file read failed'))
    r.readAsDataURL(file)
  })
  const img = document.createElement('img')
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('image decode failed'))
    img.src = dataUrl
  })
  const maxSide = 1024
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(img.width * scale)
  canvas.height = Math.round(img.height * scale)
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
  const out = canvas.toDataURL('image/jpeg', 0.85)
  return { base64: out.split(',')[1] ?? '', mimeType: 'image/jpeg' }
}

const cardCls = 'rounded-2xl border border-border-subtle bg-card/70 p-4 backdrop-blur-xl'
const btnCls = 'rounded-xl bg-coral/90 px-4 py-2 text-sm font-semibold text-white disabled:opacity-40'
const btnGhostCls = 'rounded-xl border border-border-subtle px-3 py-1.5 text-xs text-cream/80'
const inputCls = 'w-full rounded-xl border border-border-subtle bg-black/20 px-3 py-2 text-sm text-cream outline-none'

export default function KnownPeopleManager() {
  const [people, setPeople] = useState<Person[]>([])
  const [thumbs, setThumbs] = useState<Record<string, string>>({})
  const [settings, setSettings] = useState<Settings | null>(null)
  const [cameras, setCameras] = useState<Camera[]>([])
  const [workRoomId, setWorkRoomId] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [testing, setTesting] = useState(false)

  // add form
  const [name, setName] = useState('')
  const [role, setRole] = useState('staff')
  const [files, setFiles] = useState<File[]>([])

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/known-people')
      const data = await res.json()
      if (res.ok) {
        setPeople(data.people ?? [])
        setThumbs(data.thumbs ?? {})
        setSettings(data.settings ?? null)
      } else {
        setMsg(data.error ?? 'লোড করা যায়নি')
      }
    } catch {
      setMsg('লোড করা যায়নি — নেটওয়ার্ক সমস্যা')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void fetch('/api/assistant/known-people/cameras')
      .then((r) => r.json())
      .then((d) => {
        setCameras(d.cameras ?? [])
        setWorkRoomId(d.workRoomDeviceId ?? '')
      })
      .catch(() => {})
  }, [load])

  async function saveSettings(patch: Partial<Settings>) {
    if (!settings) return
    setBusy(true)
    setMsg('')
    try {
      const res = await fetch('/api/assistant/known-people/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: patch.deviceId ?? settings.deviceId,
          enabled: patch.enabled ?? settings.enabled,
          startHm: patch.startHm ?? settings.startHm,
          endHm: patch.endHm ?? settings.endHm,
          cooldownMin: patch.cooldownMin ?? settings.cooldownMin,
        }),
      })
      const data = await res.json()
      if (res.ok && data.settings) {
        setSettings(data.settings)
        setMsg('✅ সেটিংস সেভ হয়েছে')
      } else setMsg(data.error ?? 'সেভ হয়নি')
    } catch {
      setMsg('সেভ হয়নি — নেটওয়ার্ক সমস্যা')
    } finally {
      setBusy(false)
    }
  }

  async function addPerson() {
    if (!name.trim() || files.length === 0) {
      setMsg('নাম আর অন্তত ১টা ছবি দিন')
      return
    }
    setBusy(true)
    setMsg('')
    try {
      const photos = []
      for (const f of files.slice(0, 3)) photos.push(await fileToSmallBase64(f))
      const res = await fetch('/api/assistant/known-people', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, role, photos }),
      })
      const data = await res.json()
      if (res.ok) {
        setName('')
        setFiles([])
        setMsg(`✅ ${data.person?.name ?? ''} যোগ হয়েছে`)
        await load()
      } else setMsg(data.error ?? 'যোগ করা যায়নি')
    } catch {
      setMsg('যোগ করা যায়নি')
    } finally {
      setBusy(false)
    }
  }

  async function toggleActive(p: Person) {
    setBusy(true)
    try {
      await fetch(`/api/assistant/known-people/${p.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !p.active }),
      })
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function removePerson(p: Person) {
    if (!window.confirm(`${p.name}-কে মুছে ফেলবেন?`)) return
    setBusy(true)
    try {
      await fetch(`/api/assistant/known-people/${p.id}`, { method: 'DELETE' })
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function runTest() {
    setTesting(true)
    setTestResult(null)
    setMsg('')
    try {
      const res = await fetch('/api/assistant/known-people/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      setTestResult((await res.json()) as TestResult)
    } catch {
      setTestResult({ ran: false, error: 'network' })
    } finally {
      setTesting(false)
    }
  }

  if (loading) return <div className="p-6 text-sm text-cream/60">লোড হচ্ছে…</div>

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 p-4 pb-28">
      {msg ? <div className="rounded-xl bg-black/30 px-3 py-2 text-sm text-cream/90">{msg}</div> : null}

      {/* ── Entrance camera settings ── */}
      <section className={cardCls} data-testid="entrance-settings">
        <h2 className="mb-3 text-base font-semibold text-cream">🚪 এন্ট্রান্স ক্যামেরা</h2>
        {settings ? (
          <div className="flex flex-col gap-3">
            <label className="text-xs text-cream/70">
              ক্যামেরা (এন্ট্রান্স রুমেরটা বাছুন)
              <select
                className={`${inputCls} mt-1`}
                value={settings.deviceId}
                onChange={(e) => void saveSettings({ deviceId: e.target.value })}
                disabled={busy}
              >
                <option value="">— বাছাই করুন —</option>
                {cameras.map((c) => (
                  <option key={`${c.deviceId}:${c.channelId}`} value={c.deviceId}>
                    {c.channelName || c.deviceId}
                    {c.deviceId === workRoomId ? ' (Work Room — বর্তমান)' : ''}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex items-center justify-between">
              <span className="text-sm text-cream/90">ওয়াচ চালু</span>
              <button
                className={`${btnGhostCls} ${settings.enabled ? 'bg-emerald-600/30' : 'bg-red-600/20'}`}
                onClick={() => void saveSettings({ enabled: !settings.enabled })}
                disabled={busy}
                data-testid="entrance-toggle"
              >
                {settings.enabled ? 'ON ✅' : 'OFF ⛔'}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <label className="text-xs text-cream/70">
                শুরু
                <input
                  className={`${inputCls} mt-1`}
                  defaultValue={settings.startHm}
                  onBlur={(e) => void saveSettings({ startHm: e.target.value })}
                  placeholder="00:00"
                />
              </label>
              <label className="text-xs text-cream/70">
                শেষ
                <input
                  className={`${inputCls} mt-1`}
                  defaultValue={settings.endHm}
                  onBlur={(e) => void saveSettings({ endHm: e.target.value })}
                  placeholder="23:59"
                />
              </label>
              <label className="text-xs text-cream/70">
                কুলডাউন (মিনিট)
                <input
                  className={`${inputCls} mt-1`}
                  type="number"
                  defaultValue={settings.cooldownMin}
                  onBlur={(e) => void saveSettings({ cooldownMin: Number(e.target.value) })}
                />
              </label>
            </div>

            <button className={btnCls} onClick={() => void runTest()} disabled={testing || !settings.deviceId} data-testid="entrance-test">
              {testing ? 'টেস্ট চলছে… (৩০–৬০ সেকেন্ড)' : '🧪 এখনই টেস্ট করুন'}
            </button>
            {testResult ? (
              <div className="rounded-xl bg-black/30 px-3 py-2 text-sm text-cream/90" data-testid="test-result">
                {testResult.ran ? (
                  <>
                    <div>মানুষ দেখা গেছে: {testResult.peopleCount ?? 0} জন</div>
                    {testResult.identified?.length ? <div>চেনা: {testResult.identified.join(', ')}</div> : null}
                    {testResult.strangerPresent ? <div>⚠️ অচেনা কেউ আছে</div> : null}
                    {testResult.hadReferences === false ? <div>⚠️ আগে নিচে ছবি যোগ করুন — তখন চেনা/অচেনা আলাদা হবে</div> : null}
                    {testResult.summaryBn ? <div className="text-cream/70">AI: {testResult.summaryBn}</div> : null}
                    <div>{testResult.telegramSent ? '📨 Telegram-এ ছবিসহ কার্ড গেছে — দেখুন' : '⚠️ Telegram পাঠানো যায়নি'}</div>
                  </>
                ) : (
                  <div>টেস্ট ব্যর্থ: {testResult.error}</div>
                )}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="text-sm text-cream/60">সেটিংস লোড হয়নি</div>
        )}
      </section>

      {/* ── Add person ── */}
      <section className={cardCls} data-testid="add-person">
        <h2 className="mb-3 text-base font-semibold text-cream">➕ নতুন মানুষ যোগ করুন</h2>
        <div className="flex flex-col gap-3">
          <input
            className={inputCls}
            placeholder="নাম (যেমন: Maruf)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="person-name"
          />
          <select className={inputCls} value={role} onChange={(e) => setRole(e.target.value)}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
          <label className="text-xs text-cream/70">
            রেফারেন্স ছবি (১–৩টা, মুখ পরিষ্কার দেখা যায় এমন)
            <input
              className={`${inputCls} mt-1`}
              type="file"
              accept="image/*"
              multiple
              onChange={(e) => setFiles(Array.from(e.target.files ?? []).slice(0, 3))}
              data-testid="person-photos"
            />
          </label>
          {files.length > 0 ? (
            <div className="text-xs text-cream/60">{files.length}টা ছবি বাছাই হয়েছে</div>
          ) : null}
          <button className={btnCls} onClick={() => void addPerson()} disabled={busy} data-testid="person-save">
            সেভ করুন
          </button>
        </div>
      </section>

      {/* ── People list ── */}
      <section className={cardCls} data-testid="people-list">
        <h2 className="mb-3 text-base font-semibold text-cream">👥 চেনা মানুষের তালিকা ({people.length})</h2>
        {people.length === 0 ? (
          <div className="text-sm text-cream/60">
            এখনো কেউ যোগ হয়নি। আপনার আর স্টাফদের ছবি যোগ করুন — তাহলে ক্যামেরা চেনা মুখ আলাদা করতে পারবে।
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {people.map((p) => (
              <li key={p.id} className="flex items-center gap-3 rounded-xl bg-black/20 p-2">
                {thumbs[p.id] ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={thumbs[p.id]} alt={p.name} className="h-12 w-12 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-black/30 text-lg">👤</div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-cream">{p.name}</div>
                  <div className="text-xs text-cream/60">
                    {ROLES.find((r) => r.value === p.role)?.label ?? p.role} • {p.photoPaths.length}টা ছবি
                  </div>
                </div>
                <button className={btnGhostCls} onClick={() => void toggleActive(p)} disabled={busy}>
                  {p.active ? 'ON' : 'OFF'}
                </button>
                <button className={`${btnGhostCls} text-red-300`} onClick={() => void removePerson(p)} disabled={busy}>
                  মুছুন
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
