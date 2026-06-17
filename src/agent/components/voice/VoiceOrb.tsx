'use client'

import { useEffect, useRef, useState } from 'react'
import type { VoiceState } from '@/agent/lib/voice-types'

/**
 * Premium "living" voice orb. The primary renderer is a WebGL fragment shader
 * (a shaded sphere with animated fluid noise, fresnel rim glow and audio
 * reactivity — inspired by the ElevenLabs orb). If WebGL is unavailable or the
 * shader fails to compile, it falls back to a pure-CSS animated orb so the UI
 * always renders something premium.
 *
 * Palette + motion react to the voice state; the listening state also breathes
 * with the live mic level.
 */

type GLPalette = { a: [number, number, number]; b: [number, number, number]; glow: [number, number, number]; speed: number }

function hex(r: number, g: number, b: number): [number, number, number] {
  return [r, g, b]
}

const GL_PALETTES: Record<VoiceState, GLPalette> = {
  idle: { a: hex(0.97, 0.80, 0.72), b: hex(0.82, 0.32, 0.42), glow: hex(0.95, 0.55, 0.38), speed: 0.5 },
  listening: { a: hex(1.0, 0.86, 0.55), b: hex(0.91, 0.31, 0.21), glow: hex(1.0, 0.5, 0.22), speed: 1.45 },
  transcribing: { a: hex(0.66, 0.86, 0.80), b: hex(0.45, 0.46, 0.82), glow: hex(0.5, 0.78, 0.72), speed: 0.95 },
  thinking: { a: hex(0.66, 0.86, 0.80), b: hex(0.45, 0.46, 0.82), glow: hex(0.5, 0.78, 0.72), speed: 0.95 },
  speaking: { a: hex(0.80, 0.90, 1.0), b: hex(0.30, 0.40, 0.92), glow: hex(0.42, 0.58, 1.0), speed: 1.55 },
  error: { a: hex(0.97, 0.78, 0.70), b: hex(0.85, 0.30, 0.30), glow: hex(0.95, 0.5, 0.4), speed: 0.5 },
}

const VERT = `
attribute vec2 aPos;
varying vec2 vUv;
void main(){ vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }
`

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform float uTime;
uniform float uAmp;
uniform float uSpeed;
uniform vec3 uColA;
uniform vec3 uColB;
uniform vec3 uColGlow;

float hash(vec3 p){ p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float noise(vec3 x){
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i + vec3(0.0,0.0,0.0)), hash(i + vec3(1.0,0.0,0.0)), f.x),
                 mix(hash(i + vec3(0.0,1.0,0.0)), hash(i + vec3(1.0,1.0,0.0)), f.x), f.y),
             mix(mix(hash(i + vec3(0.0,0.0,1.0)), hash(i + vec3(1.0,0.0,1.0)), f.x),
                 mix(hash(i + vec3(0.0,1.0,1.0)), hash(i + vec3(1.0,1.0,1.0)), f.x), f.y), f.z);
}
float fbm(vec3 p){ float v = 0.0; float a = 0.5; for(int i = 0; i < 5; i++){ v += a * noise(p); p *= 2.02; a *= 0.5; } return v; }

void main(){
  vec2 uv = vUv * 2.0 - 1.0;
  float r = length(uv);
  if(r > 1.0){ gl_FragColor = vec4(0.0); return; }
  float z = sqrt(max(0.0, 1.0 - r * r));
  vec3 normal = vec3(uv, z);
  float t = uTime * uSpeed;

  float n  = fbm(normal * 1.8 + vec3(0.0, 0.0, t));
  float n2 = fbm(normal * 3.6 - vec3(t * 0.6, t * 0.2, 0.0));
  float mixv = clamp(0.5 + 0.7 * (n - 0.5) + 0.3 * (n2 - 0.5) + 0.15 * uAmp, 0.0, 1.0);
  vec3 col = mix(uColA, uColB, mixv);

  vec3 L = normalize(vec3(-0.45, 0.6, 0.75));
  float diff = clamp(dot(normal, L), 0.0, 1.0);
  col *= 0.55 + 0.6 * diff;

  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(clamp(dot(normal, H), 0.0, 1.0), 42.0);
  col += vec3(1.0) * spec * 0.5;

  float fres = pow(1.0 - z, 3.0);
  col += uColGlow * fres * (0.55 + 0.9 * uAmp);
  col *= 1.0 + 0.16 * uAmp;

  float alpha = smoothstep(1.0, 0.965, r);
  gl_FragColor = vec4(col, alpha);
}
`

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type)
  if (!sh) return null
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh)
    return null
  }
  return sh
}

function ampFor(state: VoiceState, micLevel: number, time: number): number {
  switch (state) {
    case 'listening': return Math.min(Math.max(micLevel, 0), 1)
    case 'speaking': return 0.45 + 0.45 * Math.sin(time * 6.0)
    case 'thinking':
    case 'transcribing': return 0.28 + 0.18 * Math.sin(time * 3.0)
    default: return 0.12 + 0.06 * Math.sin(time * 1.2)
  }
}

function VoiceOrbGL({ state, micLevel, size, onFail }: {
  state: VoiceState
  micLevel: number
  size: number
  onFail: () => void
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const stateRef = useRef(state)
  const micRef = useRef(micLevel)
  useEffect(() => { stateRef.current = state }, [state])
  useEffect(() => { micRef.current = micLevel }, [micLevel])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const gl = (canvas.getContext('webgl', { premultipliedAlpha: false, alpha: true, antialias: true })
      || canvas.getContext('experimental-webgl', { premultipliedAlpha: false, alpha: true })) as WebGLRenderingContext | null
    if (!gl) { onFail(); return }

    const vs = compile(gl, gl.VERTEX_SHADER, VERT)
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG)
    if (!vs || !fs) { onFail(); return }
    const prog = gl.createProgram()
    if (!prog) { onFail(); return }
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { onFail(); return }
    gl.useProgram(prog)

    const buf = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, buf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    const aPos = gl.getAttribLocation(prog, 'aPos')
    gl.enableVertexAttribArray(aPos)
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0)

    const uTime = gl.getUniformLocation(prog, 'uTime')
    const uAmp = gl.getUniformLocation(prog, 'uAmp')
    const uSpeed = gl.getUniformLocation(prog, 'uSpeed')
    const uColA = gl.getUniformLocation(prog, 'uColA')
    const uColB = gl.getUniformLocation(prog, 'uColB')
    const uColGlow = gl.getUniformLocation(prog, 'uColGlow')

    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
    const px = Math.round(size * dpr)
    canvas.width = px
    canvas.height = px
    gl.viewport(0, 0, px, px)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)

    let raf = 0
    const start = performance.now()
    const render = () => {
      if (document.visibilityState === 'hidden') { raf = requestAnimationFrame(render); return }
      const t = (performance.now() - start) / 1000
      const pal = GL_PALETTES[stateRef.current] ?? GL_PALETTES.idle
      const amp = ampFor(stateRef.current, micRef.current, t)
      gl.uniform1f(uTime, t)
      gl.uniform1f(uAmp, amp)
      gl.uniform1f(uSpeed, pal.speed)
      gl.uniform3fv(uColA, pal.a)
      gl.uniform3fv(uColB, pal.b)
      gl.uniform3fv(uColGlow, pal.glow)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      raf = requestAnimationFrame(render)
    }
    render()

    const onLost = (e: Event) => { e.preventDefault(); cancelAnimationFrame(raf); onFail() }
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      cancelAnimationFrame(raf)
      canvas.removeEventListener('webglcontextlost', onLost)
      gl.deleteProgram(prog); gl.deleteShader(vs); gl.deleteShader(fs); gl.deleteBuffer(buf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size])

  return <canvas ref={canvasRef} style={{ width: size, height: size, display: 'block' }} />
}

// ── CSS fallback orb (animated gradient blobs merged with blur) ──────────────

type CssPalette = { c1: string; c2: string; c3: string; c4: string; glow: string; spin: string; drift: string }

const CSS_PALETTES: Record<VoiceState, CssPalette> = {
  idle: { c1: '#F8EAE2', c2: '#EBC0AC', c3: '#DA8A6E', c4: '#b85540', glow: 'rgba(224,122,95,0.34)', spin: '22s', drift: '7s' },
  listening: { c1: '#FFE2CE', c2: '#F7B36B', c3: '#E9663F', c4: '#C73B2E', glow: 'rgba(231,102,63,0.55)', spin: '9s', drift: '2.6s' },
  transcribing: { c1: '#E6EFEA', c2: '#A6D2C4', c3: '#6FA9D6', c4: '#7C76C9', glow: 'rgba(129,178,154,0.45)', spin: '15s', drift: '4.2s' },
  thinking: { c1: '#E6EFEA', c2: '#A6D2C4', c3: '#6FA9D6', c4: '#7C76C9', glow: 'rgba(129,178,154,0.45)', spin: '15s', drift: '4.2s' },
  speaking: { c1: '#D9ECFF', c2: '#86B8F4', c3: '#5571E6', c4: '#7C3AED', glow: 'rgba(99,102,241,0.5)', spin: '7s', drift: '2.0s' },
  error: { c1: '#F8EAE2', c2: '#EBC0AC', c3: '#DA8A6E', c4: '#b85540', glow: 'rgba(224,122,95,0.34)', spin: '22s', drift: '7s' },
}

function VoiceOrbCss({ state, micLevel, size }: { state: VoiceState; micLevel: number; size: number }) {
  const p = CSS_PALETTES[state] ?? CSS_PALETTES.idle
  const glowScale = state === 'listening' ? 1 + Math.min(micLevel, 1) * 0.28 : 1
  const cssVars = {
    '--c1': p.c1, '--c2': p.c2, '--c3': p.c3, '--c4': p.c4,
    '--glow': p.glow, '--spin': p.spin, '--drift': p.drift,
    width: size, height: size,
  } as React.CSSProperties

  return (
    <div className="alma-orb" style={cssVars}>
      <div className="alma-orb__glow" style={{ transform: `scale(${glowScale})` }} />
      <div className="alma-orb__core">
        <div className="alma-orb__fluid">
          <span className="alma-orb__blob b1" />
          <span className="alma-orb__blob b2" />
          <span className="alma-orb__blob b3" />
          <span className="alma-orb__blob b4" />
        </div>
        <div className="alma-orb__shade" />
        <div className="alma-orb__highlight" />
      </div>
      <style jsx>{`
        .alma-orb { position: relative; display: flex; align-items: center; justify-content: center; }
        .alma-orb__glow { position: absolute; inset: -28%; border-radius: 9999px; background: radial-gradient(circle, var(--glow) 0%, transparent 68%); filter: blur(8px); animation: almaGlow var(--drift) ease-in-out infinite; will-change: transform, opacity; }
        .alma-orb__core { position: relative; width: 100%; height: 100%; border-radius: 9999px; overflow: hidden; background: radial-gradient(circle at 50% 50%, var(--c2), var(--c4)); box-shadow: 0 16px 50px var(--glow), inset 0 -12px 32px rgba(0,0,0,0.22), inset 0 10px 26px rgba(255,255,255,0.32); }
        .alma-orb__fluid { position: absolute; inset: -12%; filter: blur(14px) saturate(1.25); animation: almaSpin var(--spin) linear infinite; will-change: transform; }
        .alma-orb__blob { position: absolute; border-radius: 9999px; will-change: transform; }
        .b1 { width: 78%; height: 78%; top: 4%; left: 2%; background: radial-gradient(circle, var(--c1) 0%, transparent 60%); animation: almaDrift1 var(--drift) ease-in-out infinite; }
        .b2 { width: 72%; height: 72%; bottom: 0%; right: 0%; background: radial-gradient(circle, var(--c3) 0%, transparent 60%); animation: almaDrift2 var(--drift) ease-in-out infinite; animation-delay: -1.2s; }
        .b3 { width: 64%; height: 64%; top: 22%; left: 26%; background: radial-gradient(circle, var(--c2) 0%, transparent 64%); animation: almaDrift3 var(--drift) ease-in-out infinite; animation-delay: -2.4s; }
        .b4 { width: 58%; height: 58%; top: 12%; right: 6%; background: radial-gradient(circle, var(--c1) 0%, transparent 56%); animation: almaDrift1 var(--drift) ease-in-out infinite reverse; animation-delay: -0.6s; }
        .alma-orb__shade { position: absolute; inset: 0; border-radius: 9999px; background: radial-gradient(circle at 70% 76%, rgba(0,0,0,0.34) 0%, transparent 56%); pointer-events: none; }
        .alma-orb__highlight { position: absolute; inset: 0; border-radius: 9999px; background: radial-gradient(circle at 30% 25%, rgba(255,255,255,0.62) 0%, transparent 42%); pointer-events: none; animation: almaShine var(--drift) ease-in-out infinite; }
        @keyframes almaSpin { to { transform: rotate(360deg); } }
        @keyframes almaGlow { 0%,100% { opacity: 0.55; } 50% { opacity: 0.9; } }
        @keyframes almaShine { 0%,100% { opacity: 0.85; } 50% { opacity: 1; } }
        @keyframes almaDrift1 { 0%,100% { transform: translate(-10%,-6%) scale(1); } 50% { transform: translate(8%,6%) scale(1.22); } }
        @keyframes almaDrift2 { 0%,100% { transform: translate(8%,4%) scale(1.1); } 50% { transform: translate(-8%,-6%) scale(0.85); } }
        @keyframes almaDrift3 { 0%,100% { transform: translate(0%,0%) scale(0.95); } 50% { transform: translate(-6%,8%) scale(1.18); } }
        @media (prefers-reduced-motion: reduce) {
          .alma-orb__glow, .alma-orb__fluid, .alma-orb__blob, .alma-orb__highlight { animation: none !important; }
        }
      `}</style>
    </div>
  )
}

export function VoiceOrb({
  state = 'idle',
  micLevel = 0,
  size = 180,
  children,
}: {
  state?: VoiceState
  micLevel?: number
  size?: number
  children?: React.ReactNode
}) {
  const [useFallback, setUseFallback] = useState(false)

  return (
    <div
      className="alma-orb-shell"
      style={{ width: size, height: size, position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
    >
      {useFallback
        ? <VoiceOrbCss state={state} micLevel={micLevel} size={size} />
        : <VoiceOrbGL state={state} micLevel={micLevel} size={size} onFail={() => setUseFallback(true)} />}
      {children ? (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2, pointerEvents: 'none' }}>
          {children}
        </div>
      ) : null}
      <style jsx>{`
        .alma-orb-shell {
          -webkit-touch-callout: none;
          -webkit-user-select: none;
          user-select: none;
          touch-action: manipulation;
        }
      `}</style>
    </div>
  )
}

export default VoiceOrb
