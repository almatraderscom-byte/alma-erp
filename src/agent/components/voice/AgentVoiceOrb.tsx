'use client'

import dynamic from 'next/dynamic'
import type { AgentVoiceOrbProps } from './AgentVoiceOrbCanvas'

const AgentVoiceOrbCanvas = dynamic(() => import('./AgentVoiceOrbCanvas'), {
  ssr: false,
  loading: () => (
    <div className="h-40 w-40 animate-pulse rounded-full bg-gradient-to-br from-[#F6D5C8]/60 to-[#E07A5F]/40" />
  ),
})

export default function AgentVoiceOrb(props: AgentVoiceOrbProps) {
  return <AgentVoiceOrbCanvas {...props} />
}
