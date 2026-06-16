'use client'

import { Suspense } from 'react'
import { Canvas } from '@react-three/fiber'
import { OrbMesh } from './OrbMesh'
import type { AgentOrbState } from '@/agent/lib/voice-types'
import { ORB_COLORS } from '@/agent/lib/voice-types'

export interface AgentVoiceOrbProps {
  agentState?: AgentOrbState
  inputLevel?: number
  outputLevel?: number
  colors?: [string, string]
  className?: string
  size?: number
}

function OrbFallback({ size }: { size: number }) {
  return (
    <div
      className="rounded-full bg-gradient-to-br from-[#F6D5C8] to-[#E07A5F] opacity-80 animate-pulse"
      style={{ width: size, height: size }}
    />
  )
}

export default function AgentVoiceOrbCanvas({
  agentState = null,
  inputLevel = 0,
  outputLevel = 0,
  colors = ORB_COLORS,
  className = '',
  size = 160,
}: AgentVoiceOrbProps) {
  return (
    <div
      className={`relative overflow-hidden rounded-full ${className}`}
      style={{ width: size, height: size }}
      aria-hidden
    >
      <Suspense fallback={<OrbFallback size={size} />}>
        <Canvas
          camera={{ position: [0, 0, 2.8], fov: 42 }}
          dpr={[1, 2]}
          gl={{ alpha: true, antialias: true }}
          style={{ width: size, height: size, background: 'transparent' }}
        >
          <ambientLight intensity={0.55} />
          <pointLight position={[2, 2, 3]} intensity={1.2} color="#fff5f0" />
          <pointLight position={[-2, -1, 2]} intensity={0.6} color="#E07A5F" />
          <OrbMesh
            agentState={agentState}
            inputLevel={inputLevel}
            outputLevel={outputLevel}
            colors={colors}
          />
        </Canvas>
      </Suspense>
    </div>
  )
}
