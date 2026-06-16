'use client'

import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import type { AgentOrbState } from '@/agent/lib/voice-types'

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uInput;
  uniform float uOutput;
  uniform float uState;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;

  float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
  }

  float noise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n = mix(
      mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
          mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
      mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
          mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    return n;
  }

  void main() {
    vNormal = normalize(normalMatrix * normal);
    vec3 pos = position;
    float amp = 0.08 + uInput * 0.22 + uOutput * 0.18;
    float speed = 1.2 + uState * 2.5;
    float n = noise(normal * 2.5 + uTime * speed);
    vNoise = n;
    pos += normal * n * amp;
    vec4 mv = modelViewMatrix * vec4(pos, 1.0);
    vView = -mv.xyz;
    gl_Position = projectionMatrix * mv;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform float uInput;
  uniform float uOutput;
  uniform float uState;
  varying vec3 vNormal;
  varying vec3 vView;
  varying float vNoise;

  void main() {
    vec3 viewDir = normalize(vView);
    float fresnel = pow(1.0 - max(dot(viewDir, vNormal), 0.0), 2.2);
    float blend = vNoise * 0.5 + fresnel * 0.5 + uInput * 0.15 + uOutput * 0.2;
    vec3 col = mix(uColorA, uColorB, clamp(blend, 0.0, 1.0));
    float glow = 0.55 + uState * 0.25 + uInput * 0.3 + uOutput * 0.35;
    gl_FragColor = vec4(col * glow, 0.95);
  }
`

function stateToUniform(state: AgentOrbState): number {
  if (state === 'listening') return 1
  if (state === 'thinking') return 0.6
  if (state === 'talking') return 0.85
  return 0.2
}

export function OrbMesh({
  agentState,
  inputLevel,
  outputLevel,
  colors,
}: {
  agentState: AgentOrbState
  inputLevel: number
  outputLevel: number
  colors: [string, string]
}) {
  const meshRef = useRef<THREE.Mesh>(null)
  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uInput: { value: 0 },
      uOutput: { value: 0 },
      uState: { value: 0.2 },
      uColorA: { value: new THREE.Color(colors[0]) },
      uColorB: { value: new THREE.Color(colors[1]) },
    }),
    [colors],
  )

  useFrame((_, delta) => {
    if (!meshRef.current) return
    const mat = meshRef.current.material as THREE.ShaderMaterial
    mat.uniforms.uTime.value += delta
    mat.uniforms.uInput.value = THREE.MathUtils.lerp(mat.uniforms.uInput.value, inputLevel, 0.25)
    mat.uniforms.uOutput.value = THREE.MathUtils.lerp(mat.uniforms.uOutput.value, outputLevel, 0.2)
    mat.uniforms.uState.value = THREE.MathUtils.lerp(mat.uniforms.uState.value, stateToUniform(agentState), 0.12)
    meshRef.current.rotation.y += delta * (0.15 + stateToUniform(agentState) * 0.35)
    meshRef.current.rotation.x = Math.sin(mat.uniforms.uTime.value * 0.4) * 0.08
  })

  return (
    <mesh ref={meshRef}>
      <sphereGeometry args={[1, 96, 96]} />
      <shaderMaterial
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        uniforms={uniforms}
        transparent
      />
    </mesh>
  )
}
