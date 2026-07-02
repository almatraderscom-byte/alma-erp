'use client'

import { useEffect, useRef } from 'react'
import type { VoiceState } from '@/agent/lib/voice-types'
import { VoiceOrb } from './VoiceOrb'

/**
 * "Fluid Orb" — the agent's consciousness, rendered as a WebGL fragment shader:
 * three hue-shifted color fields flow through each other (domain-warped fbm noise)
 * inside a glass sphere with fresnel rim light, specular highlight and a breathing
 * halo. Same technique Apple uses for the new Siri glow. A canvas ring around it
 * doubles as the live waveform (mic level while listening, speech envelope while
 * the TTS reply plays).
 *
 * Colors follow the voice state and morph smoothly (hue is eased per-frame, time-
 * based so frame drops never slow the transition):
 *   idle aqua · listening emerald · transcribing/thinking violet · speaking azure
 *   · error ember
 *
 * Devices without WebGL silently get the existing CSS `VoiceOrb` instead — the
 * console never renders empty.
 */

const HUES: Record<VoiceState, number> = {
  idle: 168,
  listening: 145,
  transcribing: 265,
  thinking: 265,
  speaking: 210,
  error: 8,
}

/** Target "aliveness" per state; listening additionally rides the live mic level. */
function activityTarget(state: VoiceState, micLevel: number, env: number): number {
  switch (state) {
    case 'listening': return 0.3 + Math.min(Math.max(micLevel, 0), 1) * 0.6
    case 'transcribing': return 0.6
    case 'thinking': return 0.85
    case 'speaking': return 0.25 + env * 0.65
    case 'error': return 0.3
    default: return 0.12
  }
}

const FRAG = `
precision mediump float;
uniform vec2 u_res; uniform float u_time; uniform float u_hue; uniform float u_amp;
float hash(vec2 p){ p=fract(p*vec2(123.34,345.45)); p+=dot(p,p+34.345); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p); vec2 f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1.0,0.0)),u.x), mix(hash(i+vec2(0.0,1.0)),hash(i+vec2(1.0,1.0)),u.x), u.y); }
float fbm(vec2 p){ float v=0.0; float a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p=p*2.03+vec2(7.3,3.1); a*=0.5; } return v; }
vec3 hsl2rgb(float h, float s, float l){
  vec3 rgb = clamp(abs(mod(h/60.0+vec3(0.0,4.0,2.0),6.0)-3.0)-1.0, 0.0, 1.0);
  float c = (1.0-abs(2.0*l-1.0))*s;
  return (rgb-0.5)*c + l; }
void main(){
  vec2 p = (gl_FragCoord.xy*2.0 - u_res) / min(u_res.x, u_res.y);
  float t = u_time;
  float breath = sin(t*1.37)*0.5+0.5;
  float R = 0.50 + 0.016*breath + 0.05*u_amp;
  float r = length(p);
  float ang = t*0.10;
  mat2 rot = mat2(cos(ang), -sin(ang), sin(ang), cos(ang));
  vec2 q = rot * p;
  float spd = 0.16 + u_amp*0.6;
  vec2 w = q*1.9;
  float n1 = fbm(w + vec2(t*spd, -t*spd*0.7));
  float n2 = fbm(w*1.6 + 4.0*vec2(n1, n1*0.7) + vec2(-t*spd*0.8, t*spd*0.5));
  vec3 c1 = hsl2rgb(u_hue,      0.88, 0.55);
  vec3 c2 = hsl2rgb(u_hue+46.0, 0.85, 0.46);
  vec3 c3 = hsl2rgb(u_hue-38.0, 0.90, 0.62);
  vec3 col = mix(c1, c2, smoothstep(0.25, 0.75, n1));
  col = mix(col, c3, smoothstep(0.42, 0.9, n2)*0.6);
  float nz = sqrt(max(0.0, 1.0 - (r*r)/(R*R)));
  col *= 0.26 + 0.72*nz;
  col *= 1.0 - 0.30*smoothstep(0.0, 1.0, (-p.y/R)*0.5+0.5)*(1.0-nz*0.6);
  float core = exp(-r*r*6.0);
  col += hsl2rgb(u_hue, 0.55, 0.85)*core*(0.10 + 0.28*u_amp*(0.55+0.45*sin(t*8.0)));
  float fres = pow(1.0-nz, 2.6);
  col += hsl2rgb(u_hue+18.0, 0.9, 0.68)*fres*0.85;
  vec2 hp = p - vec2(-0.42, 0.46)*R;
  col += vec3(1.0)*exp(-dot(hp,hp)*52.0)*0.5;
  float inside = smoothstep(R, R-0.012, r);
  float halo = exp(-max(r-R, 0.0)*6.5);
  vec3 haloCol = hsl2rgb(u_hue, 0.9, 0.60)*halo*(0.30+0.35*u_amp);
  vec3 outCol = col*inside + haloCol*(1.0-inside);
  float alpha = max(inside, halo*(0.5+0.3*u_amp)*(1.0-inside));
  gl_FragColor = vec4(outCol, alpha);
}`

const RING_BARS = 72

export function FluidOrb({
  state = 'idle',
  micLevel = 0,
  size = 260,
}: {
  state?: VoiceState
  micLevel?: number
  size?: number
}) {
  const glCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const ringCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const glFailedRef = useRef(false)
  const fallbackRef = useRef<HTMLDivElement | null>(null)

  // Live inputs are read through refs so the render loop never restarts.
  const stateRef = useRef(state)
  const micRef = useRef(micLevel)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { micRef.current = micLevel }, [micLevel])

  useEffect(() => {
    const glCanvas = glCanvasRef.current
    const ringCanvas = ringCanvasRef.current
    if (!glCanvas || !ringCanvas) return

    const reduced = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches

    /* ---- 2D waveform ring ---- */
    const ctx = ringCanvas.getContext('2d')
    const amps = new Array<number>(RING_BARS).fill(0)

    /* ---- WebGL orb ---- */
    let gl: WebGLRenderingContext | null = null
    let uRes: WebGLUniformLocation | null = null
    let uTime: WebGLUniformLocation | null = null
    let uHue: WebGLUniformLocation | null = null
    let uAmp: WebGLUniformLocation | null = null
    try {
      gl = glCanvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: true })
      if (gl) {
        const g = gl
        const sh = (type: number, src: string) => {
          const s = g.createShader(type)
          if (!s) throw new Error('shader alloc failed')
          g.shaderSource(s, src)
          g.compileShader(s)
          if (!g.getShaderParameter(s, g.COMPILE_STATUS)) throw new Error(g.getShaderInfoLog(s) ?? 'compile failed')
          return s
        }
        const prog = g.createProgram()
        if (!prog) throw new Error('program alloc failed')
        g.attachShader(prog, sh(g.VERTEX_SHADER, 'attribute vec2 a; void main(){ gl_Position = vec4(a, 0.0, 1.0); }'))
        g.attachShader(prog, sh(g.FRAGMENT_SHADER, FRAG))
        g.linkProgram(prog)
        if (!g.getProgramParameter(prog, g.LINK_STATUS)) throw new Error(g.getProgramInfoLog(prog) ?? 'link failed')
        g.useProgram(prog)
        const buf = g.createBuffer()
        g.bindBuffer(g.ARRAY_BUFFER, buf)
        g.bufferData(g.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), g.STATIC_DRAW)
        const loc = g.getAttribLocation(prog, 'a')
        g.enableVertexAttribArray(loc)
        g.vertexAttribPointer(loc, 2, g.FLOAT, false, 0, 0)
        uRes = g.getUniformLocation(prog, 'u_res')
        uTime = g.getUniformLocation(prog, 'u_time')
        uHue = g.getUniformLocation(prog, 'u_hue')
        uAmp = g.getUniformLocation(prog, 'u_amp')
        g.enable(g.BLEND)
        g.blendFunc(g.SRC_ALPHA, g.ONE_MINUS_SRC_ALPHA)
      }
    } catch {
      gl = null
    }
    if (!gl) {
      // No WebGL → show the CSS fallback orb instead; skip GL in the loop.
      glFailedRef.current = true
      glCanvas.style.display = 'none'
      if (fallbackRef.current) fallbackRef.current.style.display = 'flex'
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const sizeAll = () => {
      const rr = ringCanvas.getBoundingClientRect()
      ringCanvas.width = rr.width * dpr
      ringCanvas.height = rr.height * dpr
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      if (gl) {
        const gr = glCanvas.getBoundingClientRect()
        glCanvas.width = Math.max(1, gr.width * dpr)
        glCanvas.height = Math.max(1, gr.height * dpr)
        gl.viewport(0, 0, glCanvas.width, glCanvas.height)
      }
    }
    sizeAll()
    window.addEventListener('resize', sizeAll)

    let raf = 0
    let t = 0
    let lastTs = 0
    let hue = HUES[stateRef.current] ?? HUES.idle
    let activity = 0.12

    const frame = (ts: number) => {
      // time-based easing — frame drops must not slow color/motion
      const dt = Math.min(0.05, lastTs ? (ts - lastTs) / 1000 : 0.016)
      lastTs = ts
      t += dt

      const st = stateRef.current
      const hueTarget = HUES[st] ?? HUES.idle
      hue += (hueTarget - hue) * Math.min(1, dt * 4.2)

      const env = Math.max(0, Math.sin(t * 3.4)) * Math.max(0, Math.sin(t * 1.24 + 1.6))
      const actTarget = activityTarget(st, micRef.current, env)
      activity += (actTarget - activity) * Math.min(1, dt * 5.5)

      /* waveform ring */
      if (ctx) {
        const w = ringCanvas.getBoundingClientRect().width
        const cx = w / 2
        const base = w * 0.335
        ctx.clearRect(0, 0, w, w)
        const vis = st === 'listening' || st === 'speaking' || st === 'idle'
        if (vis && !reduced) {
          const mic = micRef.current
          for (let i = 0; i < RING_BARS; i++) {
            let target = 1.5
            if (st === 'listening') {
              // real mic level shapes the ring; per-bar noise keeps it organic
              target = 2 + mic * 22 * Math.abs(Math.sin(t * 2.1 + i * 0.7)) + Math.random() * 3
            } else if (st === 'speaking') {
              target = 2 + env * (7 + Math.abs(Math.sin(i * 1.3 + t * 5)) * 13)
            } else {
              target = 1.2 + Math.sin(t * 0.9 + i * 0.35) * 0.8
            }
            amps[i] += (target - amps[i]) * 0.25
            const a = (i / RING_BARS) * Math.PI * 2 - Math.PI / 2
            const r1 = base
            const r2 = base + amps[i]
            ctx.strokeStyle = `hsla(${hue.toFixed(0)}, 90%, 68%, ${0.22 + amps[i] / 40})`
            ctx.lineWidth = 2.2
            ctx.lineCap = 'round'
            ctx.beginPath()
            ctx.moveTo(cx + Math.cos(a) * r1, cx + Math.sin(a) * r1)
            ctx.lineTo(cx + Math.cos(a) * r2, cx + Math.sin(a) * r2)
            ctx.stroke()
          }
        }
      }

      /* shader orb */
      if (gl) {
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
        gl.uniform2f(uRes, glCanvas.width, glCanvas.height)
        gl.uniform1f(uTime, reduced ? 0 : t)
        gl.uniform1f(uHue, hue)
        gl.uniform1f(uAmp, reduced ? 0.12 : activity)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', sizeAll)
      const lose = gl?.getExtension('WEBGL_lose_context')
      lose?.loseContext()
    }
  }, [])

  const thinking = state === 'thinking' || state === 'transcribing'

  return (
    <div className="fluid-orb" style={{ width: size, height: size }}>
      <div className="fo-bloom" data-state={state} />
      <canvas ref={glCanvasRef} className="fo-gl" />
      <canvas ref={ringCanvasRef} className="fo-ring" />
      {/* CSS fallback for no-WebGL devices — hidden unless GL init failed */}
      <div ref={fallbackRef} className="fo-fallback">
        <VoiceOrb state={state} micLevel={micLevel} size={Math.round(size * 0.62)} />
      </div>
      {/* thinking satellites */}
      <div className={`fo-sats${thinking ? ' on' : ''}`}><i /><i /><i /></div>

      <style jsx>{`
        .fluid-orb {
          position: relative;
          display: grid;
          place-items: center;
          -webkit-touch-callout: none;
          -webkit-user-select: none;
          user-select: none;
          touch-action: manipulation;
        }
        .fo-bloom {
          position: absolute;
          inset: -14%;
          border-radius: 9999px;
          background: radial-gradient(circle at 50% 45%, rgba(80, 220, 200, 0.22), transparent 66%);
          filter: blur(20px);
          transition: background 1s ease;
          pointer-events: none;
        }
        .fo-bloom[data-state='listening'] { background: radial-gradient(circle at 50% 45%, rgba(62, 224, 143, 0.26), transparent 66%); }
        .fo-bloom[data-state='thinking'],
        .fo-bloom[data-state='transcribing'] { background: radial-gradient(circle at 50% 45%, rgba(157, 123, 255, 0.28), transparent 66%); }
        .fo-bloom[data-state='speaking'] { background: radial-gradient(circle at 50% 45%, rgba(78, 163, 255, 0.26), transparent 66%); }
        .fo-bloom[data-state='error'] { background: radial-gradient(circle at 50% 45%, rgba(240, 110, 90, 0.26), transparent 66%); }
        .fo-gl {
          position: absolute;
          inset: -12%;
          width: 124%;
          height: 124%;
          /* Tailwind preflight sets canvas{max-width:100%}, which caps the 124%
             width while the -12% left offset stays → the whole orb shifts left
             (owner-reported, measured exactly). Never cap these canvases. */
          max-width: none;
        }
        .fo-ring {
          position: absolute;
          inset: -18%;
          width: 136%;
          height: 136%;
          max-width: none;
          pointer-events: none;
        }
        .fo-fallback {
          position: absolute;
          inset: 0;
          display: none;
          align-items: center;
          justify-content: center;
        }
        .fo-sats {
          position: absolute;
          inset: 6%;
          opacity: 0;
          transition: opacity 0.5s;
          animation: foSpin 3.6s linear infinite;
          pointer-events: none;
        }
        .fo-sats.on { opacity: 1; }
        .fo-sats i {
          position: absolute;
          width: 7px;
          height: 7px;
          border-radius: 9999px;
          background: #cdb9ff;
          box-shadow: 0 0 12px #a98cff;
        }
        .fo-sats i:nth-child(1) { top: 0; left: 50%; }
        .fo-sats i:nth-child(2) { bottom: 12%; left: 8%; }
        .fo-sats i:nth-child(3) { bottom: 12%; right: 8%; }
        @keyframes foSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) {
          .fo-sats { animation: none; }
        }
      `}</style>
    </div>
  )
}

export default FluidOrb
