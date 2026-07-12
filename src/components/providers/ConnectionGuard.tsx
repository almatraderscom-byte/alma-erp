'use client'

/**
 * ConnectionGuard — the app-wide "সংযোগ = রঙ" offline experience (owner-approved
 * WOW design, 2026-07). One instance mounts in the root layout and covers web,
 * the Android WebView and the iOS shell's web pages alike.
 *
 *  • Offline: a full-screen takeover whose backdrop-filter DRAINS the app of
 *    colour (grayscale + blur — no app DOM is touched), with a terracotta
 *    lighthouse beacon sweeping for signal, drifting dust particles (canvas),
 *    an orbiting auto-retry comet and an ৮-second retry countdown.
 *  • Reconnect: a colour flood-wave washes the app back to life + a small
 *    Dynamic-Island-style chip confirms "সংযোগ ফিরে এসেছে".
 *
 * Detection: browser online/offline events, VERIFIED against /api/health so a
 * flaky captive-portal "online" never clears the takeover falsely. While
 * offline it re-pings every 8s (the visible countdown) — the moment a ping
 * succeeds the app floods back. All best-effort; the guard can never block the
 * app (pointer-events only while the takeover is actually shown).
 */
import { useCallback, useEffect, useRef, useState } from 'react'

const RETRY_EVERY_SEC = 8
const BN = '০১২৩৪৫৬৭৮৯'
const bn = (n: number | string) => String(n).replace(/\d/g, (d) => BN[Number(d)])

async function pingHealth(timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
    return res.ok
  } catch {
    return false
  }
}

export function ConnectionGuard() {
  const [offline, setOffline] = useState(false)
  const [chip, setChip] = useState<null | 'back'>(null)
  const [flood, setFlood] = useState(0) // increments to re-trigger the wave
  const [count, setCount] = useState(RETRY_EVERY_SEC)
  const [checking, setChecking] = useState(false)

  const offlineRef = useRef(false)
  offlineRef.current = offline
  const chipTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cvRef = useRef<HTMLCanvasElement | null>(null)
  const animRef = useRef<number | null>(null)

  const goOnline = useCallback(() => {
    if (!offlineRef.current) return
    setOffline(false)
    setFlood((f) => f + 1)
    setChip('back')
    if (chipTimer.current) clearTimeout(chipTimer.current)
    chipTimer.current = setTimeout(() => setChip(null), 3200)
  }, [])

  const tryNow = useCallback(async () => {
    if (checking) return
    setChecking(true)
    const ok = await pingHealth()
    setChecking(false)
    setCount(RETRY_EVERY_SEC)
    if (ok) goOnline()
  }, [checking, goOnline])

  // Browser events, verified against the real API.
  useEffect(() => {
    const onOffline = () => setOffline(true)
    const onOnline = () => {
      void pingHealth().then((ok) => {
        if (ok) goOnline()
      })
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [goOnline])

  // Visible ৮s countdown → auto retry, only while the takeover is up.
  useEffect(() => {
    if (!offline) return
    setCount(RETRY_EVERY_SEC)
    const id = setInterval(() => {
      setCount((c) => {
        if (c <= 1) {
          void pingHealth().then((ok) => {
            if (ok) goOnline()
          })
          return RETRY_EVERY_SEC
        }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [offline, goOnline])

  // Drifting dust particles behind the beacon (compositor-cheap, stops with overlay).
  useEffect(() => {
    if (!offline) return
    const cv = cvRef.current
    if (!cv || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const fit = () => {
      cv.width = cv.clientWidth * dpr
      cv.height = cv.clientHeight * dpr
    }
    fit()
    const ctx = cv.getContext('2d')
    if (!ctx) return
    const N = 42
    const ps = Array.from({ length: N }, () => ({
      x: Math.random() * cv.width,
      y: Math.random() * cv.height,
      r: (Math.random() * 1.6 + 0.5) * dpr,
      vx: (Math.random() - 0.5) * 0.22 * dpr,
      vy: (Math.random() - 0.5) * 0.18 * dpr,
      a: Math.random() * 0.5 + 0.15,
      tw: Math.random() * Math.PI * 2,
    }))
    const tick = () => {
      ctx.clearRect(0, 0, cv.width, cv.height)
      for (const p of ps) {
        p.x += p.vx
        p.y += p.vy
        p.tw += 0.03
        if (p.x < 0) p.x = cv.width
        if (p.x > cv.width) p.x = 0
        if (p.y < 0) p.y = cv.height
        if (p.y > cv.height) p.y = 0
        const a = p.a * (0.6 + 0.4 * Math.sin(p.tw))
        ctx.beginPath()
        ctx.arc(p.x, p.y, p.r, 0, 7)
        ctx.fillStyle = `rgba(244,162,140,${a.toFixed(3)})`
        ctx.fill()
      }
      animRef.current = requestAnimationFrame(tick)
    }
    animRef.current = requestAnimationFrame(tick)
    window.addEventListener('resize', fit)
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current)
      animRef.current = null
      window.removeEventListener('resize', fit)
    }
  }, [offline])

  useEffect(() => () => {
    if (chipTimer.current) clearTimeout(chipTimer.current)
  }, [])

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: CG_CSS }} />
      {offline && (
        <div className="cg-world" role="alertdialog" aria-label="ইন্টারনেট সংযোগ নেই">
          <canvas ref={cvRef} className="cg-dust" />
          <div className="cg-inner">
            <div className="cg-beacon">
              <span className="cg-sweep" />
              <span className="cg-rpulse" />
              <span className="cg-rpulse r2" />
              <div className="cg-orbit"><i /></div>
              <div className="cg-core">
                <svg viewBox="0 0 48 44" aria-hidden="true">
                  <path className="cg-arc f3" d="M6 17 C16 7, 32 7, 42 17" />
                  <path className="cg-arc f2" d="M12 24 C19 17, 29 17, 36 24" />
                  <path className="cg-arc" d="M18 31 C21.5 27.5, 26.5 27.5, 30 31" />
                  <circle className="cg-dot" cx="24" cy="37.5" r="3.2" />
                </svg>
              </div>
            </div>
            <div className="cg-title">সংযোগ হারিয়ে গেছে</div>
            <p className="cg-sub">চিন্তা নেই — সব কাজ সেভ আছে। সিগন্যাল খোঁজা চলছে…</p>
            <button className="cg-retry" onClick={() => void tryNow()} disabled={checking}>
              <span className="cg-shine" />
              {checking ? 'চেষ্টা হচ্ছে…' : 'এখনই আবার চেষ্টা করুন'}
            </button>
            <div className="cg-auto num">
              নিজে-নিজে চেষ্টা হবে <b>{bn(count)}</b> সেকেন্ডে
            </div>
            <span className="cg-safe">🔒 অফলাইনেও ডেটা নিরাপদে সেভ থাকে</span>
          </div>
        </div>
      )}
      {flood > 0 && <div key={flood} className="cg-flood" aria-hidden="true" />}
      {chip && (
        <div className="cg-chip" role="status">
          <span className="cg-gdot" />
          <span>সংযোগ ফিরে এসেছে</span>
          <small>সব সিংক হয়ে গেছে</small>
        </div>
      )}
    </>
  )
}

const CG_CSS = `
.cg-world{position:fixed;inset:0;z-index:99990;display:flex;align-items:center;justify-content:center;
  text-align:center;padding:26px;
  background:radial-gradient(90% 60% at 50% 110%, rgba(10,10,16,.9), rgba(10,10,16,.68) 55%, rgba(10,10,16,.52));
  -webkit-backdrop-filter:grayscale(1) brightness(.62) blur(2.5px);
  backdrop-filter:grayscale(1) brightness(.62) blur(2.5px);
  animation:cg-in .5s ease}
@keyframes cg-in{from{opacity:0}to{opacity:1}}
.cg-dust{position:absolute;inset:0;width:100%;height:100%;pointer-events:none}
.cg-inner{position:relative;display:flex;flex-direction:column;align-items:center;
  font-family:var(--font-hind,'Hind Siliguri'),'Noto Sans Bengali',system-ui,sans-serif}
.cg-beacon{position:relative;width:150px;height:150px;display:grid;place-items:center;margin-bottom:4px}
.cg-sweep{position:absolute;inset:0;border-radius:50%;
  background:conic-gradient(from 0deg, rgba(244,162,140,.55) 0deg, rgba(244,162,140,.12) 46deg, transparent 78deg);
  -webkit-mask:radial-gradient(circle,transparent 27%,#000 28%);mask:radial-gradient(circle,transparent 27%,#000 28%);
  animation:cg-spin 3.2s linear infinite;filter:blur(1px)}
@keyframes cg-spin{to{transform:rotate(360deg)}}
.cg-rpulse{position:absolute;inset:14px;border-radius:50%;border:1px solid rgba(244,162,140,.5);
  animation:cg-pulse 2.6s ease-out infinite}
.cg-rpulse.r2{animation-delay:1.3s}
@keyframes cg-pulse{0%{transform:scale(.55);opacity:.8}100%{transform:scale(1.25);opacity:0}}
.cg-orbit{position:absolute;inset:-6px;animation:cg-orbitspin 8s linear infinite}
@keyframes cg-orbitspin{to{transform:rotate(360deg)}}
.cg-orbit i{position:absolute;top:0;left:50%;width:9px;height:9px;margin-left:-4.5px;border-radius:50%;
  background:#fff;box-shadow:0 0 12px 3px rgba(255,255,255,.7),0 0 26px 8px rgba(244,162,140,.5)}
.cg-core{position:relative;width:64px;height:64px;border-radius:50%;display:grid;place-items:center;
  background:radial-gradient(circle at 34% 30%, #F4A28C, #C45A3C 78%);
  box-shadow:0 0 34px rgba(224,122,95,.65),0 0 90px rgba(224,122,95,.3);
  animation:cg-breathe 2.6s ease-in-out infinite}
@keyframes cg-breathe{0%,100%{transform:scale(.96)}50%{transform:scale(1.05)}}
.cg-core svg{width:30px;height:28px}
.cg-arc{stroke:#fff;stroke-width:3.4;stroke-linecap:round;fill:none;opacity:.95}
.cg-arc.f2{opacity:.6}.cg-arc.f3{opacity:.32}
.cg-dot{fill:#fff}
.cg-title{font-size:21px;font-weight:800;letter-spacing:-.01em;color:#fff;margin-top:18px}
.cg-sub{font-size:12.8px;color:rgba(255,255,255,.66);max-width:30ch;margin:7px auto 20px}
.cg-retry{position:relative;font-family:inherit;font-size:14px;font-weight:800;color:#fff;border:none;
  cursor:pointer;border-radius:999px;padding:13px 30px;overflow:hidden;
  background:linear-gradient(135deg,#E07A5F,#C45A3C);box-shadow:0 6px 24px rgba(224,122,95,.5)}
.cg-retry:disabled{opacity:.75}
.cg-retry:focus-visible{outline:2px solid #F4A28C;outline-offset:3px}
.cg-shine{position:absolute;inset:0;transform:translateX(-100%);
  background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.4) 50%,transparent 70%);
  animation:cg-shine 2.8s 1s ease-in-out infinite}
@keyframes cg-shine{0%{transform:translateX(-100%)}55%,100%{transform:translateX(100%)}}
.cg-auto{margin-top:15px;font-size:11.5px;font-weight:600;color:rgba(255,255,255,.55);
  font-variant-numeric:tabular-nums}
.cg-auto b{color:rgba(255,255,255,.85)}
.cg-safe{margin-top:20px;display:inline-flex;gap:7px;align-items:center;font-size:11px;
  color:rgba(255,255,255,.75);background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);
  border-radius:999px;padding:7px 14px;-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px)}
.cg-flood{position:fixed;z-index:99991;left:50%;top:60%;width:40px;height:40px;margin:-20px;
  border-radius:50%;pointer-events:none;
  background:radial-gradient(circle, rgba(244,162,140,.85), rgba(224,122,95,.45) 45%, transparent 70%);
  mix-blend-mode:screen;animation:cg-flood 1.15s cubic-bezier(.2,.6,.3,1) forwards}
@keyframes cg-flood{0%{opacity:.95;transform:scale(.4)}100%{opacity:0;transform:scale(30)}}
.cg-chip{position:fixed;left:50%;top:calc(env(safe-area-inset-top,0px) + 12px);z-index:99992;
  transform:translateX(-50%);display:flex;align-items:center;gap:9px;white-space:nowrap;
  background:rgba(12,12,18,.92);color:#fff;border-radius:999px;padding:9px 17px;
  box-shadow:0 14px 34px rgba(0,0,0,.4);font-size:12px;font-weight:700;
  font-family:var(--font-hind,'Hind Siliguri'),'Noto Sans Bengali',system-ui,sans-serif;
  animation:cg-chipin .6s cubic-bezier(.32,1.4,.42,1)}
@keyframes cg-chipin{from{transform:translate(-50%,-90px)}to{transform:translate(-50%,0)}}
.cg-gdot{width:8px;height:8px;border-radius:50%;background:#22c55e;box-shadow:0 0 10px 2px rgba(34,197,94,.7)}
.cg-chip small{font-weight:500;color:rgba(255,255,255,.6);font-size:10.5px}
@media (prefers-reduced-motion: reduce){
  .cg-sweep,.cg-rpulse,.cg-orbit,.cg-core,.cg-shine{animation:none}
  .cg-flood{animation-duration:.3s}
}
`

export default ConnectionGuard
