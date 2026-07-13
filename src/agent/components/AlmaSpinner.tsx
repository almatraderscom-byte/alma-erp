'use client'

import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { agentTickHaptic } from '@/agent/lib/haptics'

export type AlmaSpinnerMode =
  | 'idle'
  | 'understanding'
  | 'thinking'
  | 'writing'
  | 'searching'
  | 'researching'

interface ModeConfig {
  rotationMs: number
  clusterMs: number
  verbEvery: number
  hapFreq: number
  verbs: string[]
}

const MODES: Record<AlmaSpinnerMode, ModeConfig> = {
  idle: {
    rotationMs: Number.POSITIVE_INFINITY,
    clusterMs: Number.POSITIVE_INFINITY,
    verbEvery: 60_000,
    hapFreq: 280,
    verbs: ['প্রস্তুত'],
  },
  understanding: {
    rotationMs: 6200,
    clusterMs: Number.POSITIVE_INFINITY,
    verbEvery: 2100,
    hapFreq: 320,
    verbs: ['বার্তাটি বুঝে নিচ্ছি', 'বুঝে নিচ্ছি'],
  },
  thinking: {
    rotationMs: 2100,
    clusterMs: 270,
    verbEvery: 1500,
    hapFreq: 370,
    verbs: ['ভাবছি', 'বিশ্লেষণ করছি', 'মিলিয়ে দেখছি', 'হিসাব করছি'],
  },
  writing: {
    rotationMs: 2200,
    clusterMs: 290,
    verbEvery: 1350,
    hapFreq: 450,
    verbs: ['উত্তর লিখছি', 'সাজাচ্ছি', 'গুছিয়ে লিখছি', 'শেষ করছি'],
  },
  searching: {
    rotationMs: 1500,
    clusterMs: Number.POSITIVE_INFINITY,
    verbEvery: 1400,
    hapFreq: 540,
    verbs: ['টুল ব্যবহার করছি', 'তথ্য আনছি', 'যাচাই করছি', 'খুঁজে দেখছি'],
  },
  researching: {
    rotationMs: 1500,
    clusterMs: Number.POSITIVE_INFINITY,
    verbEvery: 1400,
    hapFreq: 540,
    verbs: ['গবেষণা করছি', 'উৎস দেখছি', 'তথ্য আনছি', 'যাচাই করছি'],
  },
}

const RAY_OUTER = [43, 38, 45, 40, 46, 39, 44, 37, 45, 40, 47, 38]
const RAY_WIDTH = [7.8, 6.4, 7.3, 6.2, 8, 6.6, 7.5, 6.3, 7.8, 6.5, 7.4, 6.4]
const COLLAPSED_OUTER = [15, 13, 16, 14, 15, 13, 16, 14, 15, 13, 16, 14]
const THINKING_CLUSTERS = [[0, 1, 2], [3, 4], [5, 6, 7], [8, 9], [10, 11, 0]]
const ANGULAR_BOIL = [
  [0, -0.55, 0.45, -0.25, 0.35, -0.4, 0.2, -0.5, 0.4, -0.2, 0.5, -0.35],
  [0.4, -0.15, 0.05, -0.55, 0.15, -0.05, 0.55, -0.2, 0.1, -0.5, 0.25, -0.1],
  [-0.25, 0.35, -0.4, 0.1, -0.15, 0.5, -0.35, 0.3, -0.5, 0.2, -0.05, 0.45],
  [0.15, -0.4, 0.25, -0.05, 0.5, -0.3, 0.05, -0.45, 0.2, -0.1, 0.4, -0.55],
]

interface MotionState {
  mode: AlmaSpinnerMode
  modeStartedAt: number
  rotation: number
  velocity: number
  lastFrameAt: number | null
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.max(minimum, Math.min(maximum, value))

const positiveModulo = (value: number, divisor: number) =>
  ((value % divisor) + divisor) % divisor

function smoothstep(value: number) {
  const clamped = clamp(value, 0, 1)
  return clamped * clamped * (3 - 2 * clamped)
}

function toolStarAmount(elapsed: number) {
  const cycle = positiveModulo(elapsed, 1500) / 1500
  if (cycle < 0.16) return 1
  if (cycle < 0.34) return 1 - smoothstep((cycle - 0.16) / 0.18)
  if (cycle < 0.72) return 0
  if (cycle < 0.9) return smoothstep((cycle - 0.72) / 0.18)
  return 1
}

function clusterRetraction(index: number, elapsed: number, clusterDuration: number) {
  if (!Number.isFinite(clusterDuration)) return 0
  const clusterPosition = elapsed / clusterDuration
  const clusterIndex = positiveModulo(Math.floor(clusterPosition), THINKING_CLUSTERS.length)
  const memberPosition = (THINKING_CLUSTERS[clusterIndex] ?? []).indexOf(index)
  if (memberPosition < 0) return 0
  const localProgress = clusterPosition - Math.floor(clusterPosition)
  const stagger = memberPosition * 0.045
  const adjusted = clamp((localProgress - stagger) / (1 - stagger * 1.4), 0, 1)
  return Math.sin(Math.PI * smoothstep(adjusted))
}

function understandingRetraction(index: number, elapsed: number) {
  const shifted = clamp((elapsed - (index % 3) * 22) / 2040, 0, 1)
  if (shifted < 0.46) return smoothstep(shifted / 0.46)
  return 1 - smoothstep((shifted - 0.46) / 0.54)
}

function readAuraPalette(fallback: string) {
  if (typeof document === 'undefined') return [fallback]
  const styles = getComputedStyle(document.documentElement)
  return [1, 2, 3, 4, 5]
    .map((index) => styles.getPropertyValue(`--aurora-blob-${index}`).trim())
    .map((value) => value || fallback)
}

let audioContext: AudioContext | null = null
function getAudioContext() {
  if (typeof window === 'undefined') return null
  const Constructor = window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Constructor) return null
  if (!audioContext) {
    try {
      audioContext = new Constructor()
    } catch {
      return null
    }
  }
  if (audioContext.state === 'suspended') void audioContext.resume()
  return audioContext
}

function playTick(frequency: number) {
  const context = getAudioContext()
  if (!context || context.state !== 'running') return
  const now = context.currentTime
  const oscillator = context.createOscillator()
  const gain = context.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(0, now)
  gain.gain.linearRampToValueAtTime(0.025, now + 0.004)
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
  oscillator.connect(gain).connect(context.destination)
  oscillator.start(now)
  oscillator.stop(now + 0.065)
}

export interface AlmaSpinnerProps {
  mode?: AlmaSpinnerMode
  haptics?: boolean
  sound?: boolean
  size?: number
  color?: string
  showVerb?: boolean
  style?: CSSProperties
}

export function AlmaSpinner({
  mode = 'thinking',
  haptics = true,
  sound = false,
  size = 22,
  color = '#E07A5F',
  showVerb = true,
  style = {},
}: AlmaSpinnerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const motionRef = useRef<MotionState>({
    mode,
    modeStartedAt: typeof performance === 'undefined' ? 0 : performance.now(),
    rotation: 0,
    velocity: 0,
    lastFrameAt: null,
  })
  const [verbIndex, setVerbIndex] = useState(0)
  const config = MODES[mode] ?? MODES.thinking

  useEffect(() => {
    const motion = motionRef.current
    motion.mode = mode
    motion.modeStartedAt = performance.now()
    setVerbIndex(0)
  }, [mode])

  useEffect(() => {
    const id = window.setInterval(() => {
      setVerbIndex((index) => (index + 1) % Math.max(1, config.verbs.length))
    }, config.verbEvery)
    return () => window.clearInterval(id)
  }, [config])

  useEffect(() => {
    if ((!haptics && !sound) || mode === 'idle') return
    let cancelled = false
    let timeout: number | undefined
    const pulse = () => {
      if (haptics) agentTickHaptic(7)
      if (sound) playTick(config.hapFreq)
    }
    const wait = (milliseconds: number) => new Promise<void>((resolve) => {
      timeout = window.setTimeout(resolve, milliseconds)
    })

    // The start pulse marks the visual mode handoff. Subsequent micro-pulses are
    // scheduled against exact shape events rather than the unrelated rotation.
    pulse()
    void (async () => {
      if (mode === 'understanding') {
        await wait(940)
        if (!cancelled) pulse()
        return
      }
      if (mode === 'searching' || mode === 'researching') {
        while (!cancelled) {
          await wait(510) // dot ring has fully settled (34% of 1.5s)
          if (cancelled) return
          pulse()
          await wait(840) // star has fully reopened (90% of 1.5s)
          if (cancelled) return
          pulse()
          await wait(150)
        }
        return
      }

      const clusterMs = config.clusterMs
      await wait(clusterMs / 2)
      while (!cancelled) {
        pulse() // adjacent ray group is at maximum retraction
        await wait(clusterMs)
      }
    })()

    return () => {
      cancelled = true
      if (timeout) window.clearTimeout(timeout)
    }
  }, [config, haptics, mode, sound])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const context = canvas.getContext('2d')
    if (!context) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const box = Math.round(size * 1.48)
    canvas.width = box * dpr
    canvas.height = box * dpr
    canvas.style.width = `${box}px`
    canvas.style.height = `${box}px`
    let animationFrame = 0
    const palette = readAuraPalette(color)

    const draw = (now: number) => {
      const motion = motionRef.current
      const activeMode = motion.mode
      const activeConfig = MODES[activeMode] ?? MODES.thinking
      const elapsed = Math.max(0, now - motion.modeStartedAt)
      const deltaSeconds = motion.lastFrameAt === null
        ? 0
        : clamp((now - motion.lastFrameAt) / 1000, 0, 0.05)
      motion.lastFrameAt = now
      const targetVelocity = Number.isFinite(activeConfig.rotationMs)
        ? Math.PI * 2 / (activeConfig.rotationMs / 1000)
        : 0
      const velocityBlend = 1 - Math.exp(-deltaSeconds * 4.8)
      motion.velocity += (targetVelocity - motion.velocity) * velocityBlend
      motion.rotation = positiveModulo(
        motion.rotation + motion.velocity * deltaSeconds,
        Math.PI * 2,
      )

      const boilFrame = positiveModulo(
        Math.floor(elapsed / (activeMode === 'idle' ? 145 : 95)),
        ANGULAR_BOIL.length,
      )
      const boilRow = ANGULAR_BOIL[boilFrame] ?? ANGULAR_BOIL[0] ?? []
      const toolLike = activeMode === 'searching' || activeMode === 'researching'
      const toolAmount = toolLike ? toolStarAmount(elapsed) : 1
      const unit = size / 100

      context.setTransform(dpr, 0, 0, dpr, 0, 0)
      context.clearRect(0, 0, box, box)
      context.save()
      context.translate(box / 2, box / 2)
      context.rotate(motion.rotation)
      context.scale(unit, unit)
      context.lineCap = 'round'

      for (let index = 0; index < 12; index += 1) {
        const boilScale = activeMode === 'idle' ? 0.45 : toolLike ? 0.28 : 1
        const boilDegrees = (boilRow[index] ?? 0) * boilScale
        const angle = index / 12 * Math.PI * 2 - Math.PI / 2 + boilDegrees * Math.PI / 180
        const transitionSpread = 4 * toolAmount * (1 - toolAmount)
        const rayAmount = toolLike
          ? clamp(toolAmount + Math.sin(index * 1.71 + elapsed / 210) * 0.11 * transitionSpread, 0, 1)
          : 1

        let retract = 0
        if (activeMode === 'thinking' || activeMode === 'writing') {
          retract = clusterRetraction(index, elapsed, activeConfig.clusterMs) * smoothstep(elapsed / 520)
        } else if (activeMode === 'understanding') {
          retract = understandingRetraction(index, elapsed)
        }

        const starInner = 5.5
        const targetOuter = activeMode === 'understanding' ? 18 : COLLAPSED_OUTER[index]
        const starOuter = RAY_OUTER[index] + (targetOuter - RAY_OUTER[index]) * retract
        const ringRadius = 31.5
        const innerRadius = ringRadius + (starInner - ringRadius) * rayAmount
        const outerRadius = ringRadius + (starOuter - ringRadius) * rayAmount
        const width = RAY_WIDTH[index] + (7.2 - RAY_WIDTH[index]) * (1 - rayAmount)
        const ink = palette[Math.min(palette.length - 1, Math.floor(index / 3))] ?? color

        context.strokeStyle = ink
        context.fillStyle = ink
        context.shadowColor = ink
        context.shadowBlur = size > 40 ? 6 : 1.4
        context.globalAlpha = 0.76 + 0.24 * rayAmount
        context.lineWidth = width
        context.beginPath()
        context.moveTo(Math.cos(angle) * innerRadius, Math.sin(angle) * innerRadius)
        context.lineTo(Math.cos(angle) * (outerRadius + 0.01), Math.sin(angle) * (outerRadius + 0.01))
        context.stroke()

        if (rayAmount < 0.04) {
          context.beginPath()
          context.arc(Math.cos(angle) * ringRadius, Math.sin(angle) * ringRadius, width / 2, 0, Math.PI * 2)
          context.fill()
        }
      }

      context.restore()
      context.globalAlpha = 1
      animationFrame = window.requestAnimationFrame(draw)
    }

    animationFrame = window.requestAnimationFrame(draw)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [color, size])

  const verb = config.verbs[verbIndex % Math.max(1, config.verbs.length)] ?? config.verbs[0]

  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 10, position: 'relative', ...style }}
      role="status"
      aria-label={`${verb}…`}
    >
      <span
        aria-hidden
        style={{
          position: 'absolute',
          left: Math.round(size * 0.18),
          width: Math.round(size * 1.1),
          height: Math.round(size * 1.1),
          borderRadius: '50%',
          filter: 'blur(10px)',
          opacity: mode === 'idle' ? 0.16 : 0.32,
          background: 'radial-gradient(circle, var(--aurora-blob-3), transparent 70%)',
          pointerEvents: 'none',
        }}
      />
      <canvas ref={canvasRef} aria-hidden style={{ display: 'block', flex: '0 0 auto' }} />
      {showVerb && (
        <span style={{ fontSize: Math.round(size * 0.62), color: 'inherit', fontWeight: 500 }}>
          {verb}…
        </span>
      )}
    </span>
  )
}
