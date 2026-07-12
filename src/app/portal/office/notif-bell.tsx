'use client'

/**
 * Office notification bell + panel + the ALMA Island.
 *
 * WOW redesign (owner-approved 2026-07):
 *  • Panel cards get tone medallions (approved = green medal that flips in with
 *    a light glint + self-drawing check; redo = amber redo ring with the Boss's
 *    note as a quote; new task = blue; award = gold) and a spring entrance.
 *  • The ALMA Island — a Dynamic-Island-style pill that drops from the top when
 *    a NEW approved/redo/award result lands (poll-detected), springs open with
 *    the result, fires a confetti burst for good news, then folds away.
 * Everything is best-effort and self-contained; polling stays at 30s.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { NotificationFeed, OfficeNotice } from '@/agent/lib/office-notifications'

const POLL_MS = 30_000
const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'এইমাত্র'
  if (m < 60) return `${bn(m)} মিনিট আগে`
  const h = Math.floor(m / 60)
  if (h < 24) return `${bn(h)} ঘণ্টা আগে`
  return `${bn(Math.floor(h / 24))} দিন আগে`
}

/** kind → medallion tone + glyph. Result kinds get the full celebration/urgency. */
type Tone = 'ok' | 'warn' | 'bad' | 'task' | 'gold' | 'plain'
const KIND_TONE: Record<string, { tone: Tone; icon: string }> = {
  approved: { tone: 'ok', icon: '✓' },
  completed: { tone: 'ok', icon: '✓' },
  redo: { tone: 'warn', icon: '↺' },
  update_request: { tone: 'warn', icon: '⏰' },
  escalation: { tone: 'bad', icon: '🚨' },
  task_assigned: { tone: 'task', icon: '📋' },
  self_initiated: { tone: 'task', icon: '✨' },
  award: { tone: 'gold', icon: '🏆' },
  comment: { tone: 'plain', icon: '💬' },
  group_message: { tone: 'plain', icon: '👥' },
}
const toneOf = (kind: string) => KIND_TONE[kind] ?? { tone: 'plain' as Tone, icon: '🔔' }

/** Island-worthy result kinds — the "approved or rejected" moments. */
const ISLAND_KINDS = new Set(['approved', 'redo', 'award'])
const CONFETTI_KINDS = new Set(['approved', 'award'])

export default function NotifBell() {
  const router = useRouter()
  const [feed, setFeed] = useState<NotificationFeed>({ unread: 0, items: [] })
  const [open, setOpen] = useState(false)
  const [island, setIsland] = useState<OfficeNotice | null>(null)
  const [islandOpen, setIslandOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const confettiRef = useRef<HTMLCanvasElement>(null)
  const seenRef = useRef<Set<string> | null>(null) // null = first load pending
  const islandTimers = useRef<ReturnType<typeof setTimeout>[]>([])

  const fireConfetti = useCallback(() => {
    const cv = confettiRef.current
    if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    cv.width = cv.clientWidth * dpr
    cv.height = cv.clientHeight * dpr
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const cols = ['#E07A5F', '#F4A28C', '#F2C48D', '#4ade80', '#8b5cf6', '#fff']
    const ps = Array.from({ length: 90 }, () => {
      const a = (Math.random() * 0.9 + 0.05) * Math.PI
      const sp = (Math.random() * 6 + 3) * dpr
      return {
        x: cv.width / 2 + (Math.random() - 0.5) * cv.width * 0.4,
        y: cv.height * 0.12,
        vx: Math.cos(a) * sp * (Math.random() < 0.5 ? -1 : 1) * 0.6,
        vy: Math.sin(a) * sp * 0.9,
        s: (Math.random() * 5 + 3) * dpr,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.3,
        c: cols[Math.floor(Math.random() * cols.length)],
        life: 1,
      }
    })
    const tick = () => {
      ctx.clearRect(0, 0, cv.width, cv.height)
      let alive = 0
      for (const p of ps) {
        p.x += p.vx
        p.y += p.vy
        p.vy += 0.12 * dpr
        p.rot += p.vr
        p.life -= 0.009
        if (p.life <= 0 || p.y > cv.height) continue
        alive++
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.rot)
        ctx.globalAlpha = Math.max(0, p.life)
        ctx.fillStyle = p.c
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2)
        ctx.restore()
      }
      if (alive > 0) requestAnimationFrame(tick)
      else ctx.clearRect(0, 0, cv.width, cv.height)
    }
    requestAnimationFrame(tick)
  }, [])

  const showIsland = useCallback(
    (n: OfficeNotice) => {
      islandTimers.current.forEach(clearTimeout)
      islandTimers.current = []
      setIsland(n)
      setIslandOpen(false)
      islandTimers.current.push(
        setTimeout(() => {
          setIslandOpen(true)
          if (CONFETTI_KINDS.has(n.kind)) fireConfetti()
        }, 420),
      )
      islandTimers.current.push(setTimeout(() => setIslandOpen(false), 5200))
      islandTimers.current.push(setTimeout(() => setIsland(null), 5700))
    },
    [fireConfetti],
  )

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/assistant/office/notifications', { cache: 'no-store' })
      if (!res.ok) return
      const data = (await res.json()) as NotificationFeed
      setFeed(data)
      // Island detection: a result item we have never seen before, still unread.
      if (seenRef.current === null) {
        seenRef.current = new Set(data.items.map((n) => n.id))
        return
      }
      const seen = seenRef.current
      const fresh = data.items.find((n) => !n.read && !seen.has(n.id) && ISLAND_KINDS.has(n.kind))
      data.items.forEach((n) => seen.add(n.id))
      if (fresh) showIsland(fresh)
    } catch {
      /* best-effort */
    }
  }, [showIsland])

  useEffect(() => {
    load()
    const id = setInterval(load, POLL_MS)
    return () => clearInterval(id)
  }, [load])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  useEffect(
    () => () => {
      islandTimers.current.forEach(clearTimeout)
    },
    [],
  )

  const markAll = async () => {
    await fetch('/api/assistant/office/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    await load()
    router.refresh()
  }

  const onItem = async (n: OfficeNotice) => {
    if (!n.read) {
      await fetch('/api/assistant/office/notifications', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: n.id }),
      })
      load()
    }
    setOpen(false)
    router.refresh()
  }

  const islandTone = island ? toneOf(island.kind) : null

  return (
    <div ref={boxRef} style={{ display: 'inline-block' }}>
      <style dangerouslySetInnerHTML={{ __html: ONX_CSS }} />
      <button className="bell" onClick={() => setOpen((v) => !v)} aria-label="নোটিফিকেশন">
        🔔
        {feed.unread > 0 && <span className="bdot">{feed.unread > 9 ? '৯+' : bn(feed.unread)}</span>}
      </button>

      {open && (
        <div className="ohub-notif">
          <div className="nh">
            <b>নোটিফিকেশন</b>
            {feed.unread > 0 && <button onClick={markAll}>সব পড়া হয়েছে</button>}
          </div>
          <div className="nlist onx-list">
            {feed.items.length === 0 && <div className="nempty">কোনো নোটিফিকেশন নেই।</div>}
            {feed.items.map((n, i) => {
              const t = toneOf(n.kind)
              const isRedo = n.kind === 'redo' || n.kind === 'update_request'
              return (
                <button
                  key={n.id}
                  className={`onx-card${n.read ? '' : ' unread'}`}
                  style={{ animationDelay: `${Math.min(i, 6) * 60}ms` }}
                  onClick={() => onItem(n)}
                >
                  <span className={`onx-med ${t.tone}`}>
                    {t.tone === 'ok' ? (
                      <svg viewBox="0 0 24 24" aria-hidden="true">
                        <path className="onx-ck" d="M5 12.5 L10 17.5 L19 7" />
                      </svg>
                    ) : (
                      <i>{t.icon}</i>
                    )}
                    {t.tone === 'ok' && <span className="onx-glint" />}
                  </span>
                  <span className="onx-body">
                    <span className="onx-t">
                      <b>{n.title}</b>
                      <time>{timeAgo(n.createdAt)}</time>
                    </span>
                    {n.body &&
                      (isRedo ? (
                        <span className="onx-quote">{n.body}</span>
                      ) : (
                        <span className="onx-b">{n.body}</span>
                      ))}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── the ALMA Island (fixed, app-wide within the office) ── */}
      {island && islandTone && (
        <>
          <canvas ref={confettiRef} className="onx-confetti" aria-hidden="true" />
          <div
            className={`onx-isle ${islandTone.tone}${islandOpen ? ' open' : ''}`}
            role="status"
            aria-live="polite"
          >
            <div className="onx-isle-mini">
              <span className="idot" />
              ALMA
            </div>
            <div className="onx-isle-full">
              <span className="onx-isle-ic">
                {island.kind === 'approved' ? '✅' : island.kind === 'award' ? '🏆' : '🔄'}
              </span>
              <span className="onx-isle-tx">
                <b>{island.title}</b>
                {island.body && <span>{island.body}</span>}
              </span>
              <span className="ibar">
                <i />
              </span>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

const ONX_CSS = `
/* ── panel cards ── */
.onx-list{padding:6px}
.onx-card{position:relative;display:flex;gap:11px;width:100%;text-align:left;padding:11px 12px;
  border:1px solid rgba(255,255,255,0.06);border-radius:14px;background:rgba(255,255,255,0.025);
  color:inherit;cursor:pointer;font-family:inherit;margin-bottom:6px;
  opacity:0;transform:translateY(14px);animation:onx-rise .5s cubic-bezier(.3,1.3,.45,1) forwards}
@keyframes onx-rise{60%{opacity:1}100%{opacity:1;transform:translateY(0)}}
.onx-card.unread{background:rgba(224,122,95,.07);border-color:rgba(224,122,95,.22)}
.onx-card.unread::after{content:"";position:absolute;top:13px;right:11px;width:7px;height:7px;
  border-radius:50%;background:#E07A5F;box-shadow:0 0 0 3px rgba(224,122,95,.18)}
.onx-med{position:relative;flex:none;width:40px;height:40px;border-radius:13px;display:grid;place-items:center;overflow:hidden}
.onx-med i{font-style:normal;font-size:17px;line-height:1}
.onx-med.ok{background:linear-gradient(135deg,rgba(34,197,94,.22),rgba(34,197,94,.08));border:1px solid rgba(34,197,94,.35);
  box-shadow:0 4px 16px rgba(34,197,94,.2)}
.onx-med.warn{background:rgba(245,158,11,.14);border:1px solid rgba(245,158,11,.32);color:#fcd34d}
.onx-med.warn i{font-size:19px;font-weight:800}
.onx-med.bad{background:rgba(239,68,68,.13);border:1px solid rgba(239,68,68,.3)}
.onx-med.task{background:rgba(96,165,250,.13);border:1px solid rgba(96,165,250,.3)}
.onx-med.gold{background:rgba(242,196,141,.15);border:1px solid rgba(242,196,141,.4)}
.onx-med.plain{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1)}
.onx-med svg{width:21px;height:21px}
.onx-ck{stroke:#4ade80;stroke-width:2.8;fill:none;stroke-linecap:round;stroke-linejoin:round;
  stroke-dasharray:26;stroke-dashoffset:26;animation:onx-draw .5s .5s ease-out forwards}
@keyframes onx-draw{to{stroke-dashoffset:0}}
.onx-glint{position:absolute;inset:-40%;transform:translateX(-110%) rotate(18deg);
  background:linear-gradient(100deg,transparent 42%,rgba(255,255,255,.5) 50%,transparent 58%);
  animation:onx-glint 1s 1s ease-out forwards}
@keyframes onx-glint{to{transform:translateX(110%) rotate(18deg)}}
.onx-body{min-width:0;flex:1}
.onx-t{display:flex;align-items:baseline;gap:8px}
.onx-t b{font-size:12.5px;font-weight:700;line-height:1.35;min-width:0}
.onx-t time{margin-left:auto;flex:none;font-size:10px;color:#AEB2C0;font-weight:600}
.onx-b{display:block;font-size:11.5px;color:#AEB2C0;margin-top:2px;overflow:hidden;
  text-overflow:ellipsis;white-space:nowrap}
.onx-quote{display:block;margin-top:6px;font-size:11.5px;color:#D0D4E0;background:rgba(255,255,255,.05);
  border-left:2.5px solid #f59e0b;border-radius:0 9px 9px 0;padding:6px 10px}

/* ── the ALMA Island ── */
.onx-confetti{position:fixed;left:0;right:0;top:0;height:46vh;width:100%;z-index:94;pointer-events:none}
.onx-isle{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 10px);z-index:95;
  transform:translateX(-50%);background:rgba(12,12,18,.94);color:#fff;border-radius:24px;overflow:hidden;
  width:110px;height:30px;box-shadow:0 16px 40px rgba(0,0,0,.45),inset 0 0 0 1px rgba(255,255,255,.09);
  font-family:'Hind Siliguri','Noto Sans Bengali',Inter,system-ui,sans-serif;
  transition:width .55s cubic-bezier(.32,1.35,.42,1),height .55s cubic-bezier(.32,1.35,.42,1),border-radius .55s;
  animation:onx-peek .35s ease}
@keyframes onx-peek{from{opacity:0;transform:translate(-50%,-40px)}to{opacity:1;transform:translate(-50%,0)}}
.onx-isle.open{width:min(560px,calc(100vw - 22px));height:74px;border-radius:26px}
.onx-isle-mini{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;gap:8px;
  font-size:11px;font-weight:700;letter-spacing:.08em;transition:opacity .25s}
.onx-isle.open .onx-isle-mini{opacity:0}
.onx-isle-mini .idot{width:7px;height:7px;border-radius:50%;background:#F4A28C;
  box-shadow:0 0 8px 2px rgba(244,162,140,.6)}
.onx-isle-full{position:absolute;inset:0;display:flex;align-items:center;gap:12px;padding:0 16px;
  opacity:0;transition:opacity .3s .18s}
.onx-isle.open .onx-isle-full{opacity:1}
.onx-isle-ic{flex:none;width:42px;height:42px;border-radius:14px;display:grid;place-items:center;font-size:19px}
.onx-isle.ok .onx-isle-ic,.onx-isle.gold .onx-isle-ic{background:rgba(34,197,94,.18);
  box-shadow:inset 0 0 0 1px rgba(34,197,94,.4)}
.onx-isle.gold .onx-isle-ic{background:rgba(242,196,141,.16);box-shadow:inset 0 0 0 1px rgba(242,196,141,.45)}
.onx-isle.warn .onx-isle-ic{background:rgba(245,158,11,.16);box-shadow:inset 0 0 0 1px rgba(245,158,11,.4)}
.onx-isle-tx{min-width:0;flex:1}
.onx-isle-tx b{display:block;font-size:13px;letter-spacing:-.01em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.onx-isle-tx span{display:block;font-size:11px;color:rgba(255,255,255,.62);white-space:nowrap;
  overflow:hidden;text-overflow:ellipsis}
.onx-isle .ibar{position:absolute;left:18px;right:18px;bottom:6px;height:2.5px;border-radius:99px;
  background:rgba(255,255,255,.14);overflow:hidden;opacity:0;transition:opacity .3s .2s}
.onx-isle.open .ibar{opacity:1}
.onx-isle .ibar i{display:block;height:100%;transform-origin:left;background:#4ade80}
.onx-isle.warn .ibar i{background:#fbbf24}
.onx-isle.open .ibar i{animation:onx-drain 4.6s .25s linear forwards}
@keyframes onx-drain{from{transform:scaleX(1)}to{transform:scaleX(0)}}
@media (prefers-reduced-motion: reduce){
  .onx-card{animation-duration:.01ms}
  .onx-ck,.onx-glint{animation-delay:0s;animation-duration:.01ms}
}
`
