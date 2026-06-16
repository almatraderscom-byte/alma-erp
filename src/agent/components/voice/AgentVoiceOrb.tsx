'use client'

import { Component, type ReactNode } from 'react'
import dynamic from 'next/dynamic'
import type { AgentVoiceOrbProps } from './AgentVoiceOrbCanvas'
import VoiceOrbFallback from './VoiceOrbFallback'

class OrbErrorBoundary extends Component<
  { children: ReactNode; size: number },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return <VoiceOrbFallback size={this.props.size} />
    return this.props.children
  }
}

const AgentVoiceOrbCanvas = dynamic(() => import('./AgentVoiceOrbCanvas'), {
  ssr: false,
  loading: () => <VoiceOrbFallback size={160} />,
})

export default function AgentVoiceOrb(props: AgentVoiceOrbProps) {
  const size = props.size ?? 160
  return (
    <OrbErrorBoundary size={size}>
      <AgentVoiceOrbCanvas {...props} />
    </OrbErrorBoundary>
  )
}
