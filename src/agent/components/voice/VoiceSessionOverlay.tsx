'use client'

import { motion, AnimatePresence } from 'framer-motion'
import AgentVoiceOrb from './AgentVoiceOrb'
import type { AgentOrbState, VoiceMode } from '@/agent/lib/voice-types'

const STATUS_LABEL: Record<string, string> = {
  listening: 'শুনছি…',
  thinking: 'ভাবছি…',
  talking: 'বলছি…',
  transcribing: 'ট্রান্সক্রাইব…',
  idle: 'বলুন…',
}

export default function VoiceSessionOverlay({
  open,
  agentState,
  inputLevel,
  outputLevel,
  voiceMode,
  phase,
  onClose,
  onTapOrb,
}: {
  open: boolean
  agentState: AgentOrbState
  inputLevel: number
  outputLevel: number
  voiceMode: VoiceMode
  phase: 'idle' | 'listening' | 'transcribing' | 'thinking' | 'talking'
  onClose: () => void
  onTapOrb?: () => void
}) {
  const label = STATUS_LABEL[phase] ?? STATUS_LABEL.idle

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-end bg-gradient-to-b from-[#FDF8F3]/92 via-[#FDF8F3]/75 to-transparent pb-36 pt-16 backdrop-blur-[2px] md:pb-40"
        >
          <div className="pointer-events-auto flex flex-col items-center gap-3">
            <motion.button
              type="button"
              onClick={onTapOrb}
              className="relative flex items-center justify-center rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-[#E07A5F]/40"
              initial={{ scale: 0.85, y: 24 }}
              animate={{ scale: 1, y: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 22 }}
              aria-label={voiceMode === 'conversation' ? 'ভয়েস মোড — বলুন' : 'রেকর্ডিং'}
            >
              <motion.div
                className="absolute rounded-full blur-3xl"
                style={{
                  width: 200,
                  height: 200,
                  background: 'radial-gradient(circle, rgba(224,122,95,0.35) 0%, transparent 70%)',
                }}
                animate={{
                  opacity: phase === 'listening' ? [0.4, 0.75, 0.4] : [0.25, 0.45, 0.25],
                  scale: [0.9, 1.05 + inputLevel * 0.15, 0.9],
                }}
                transition={{ duration: phase === 'listening' ? 1.2 : 3, repeat: Infinity, ease: 'easeInOut' }}
              />
              <AgentVoiceOrb
                agentState={agentState}
                inputLevel={inputLevel}
                outputLevel={outputLevel}
                size={176}
              />
            </motion.button>

            <p className="text-sm font-semibold text-[#1a1a2e]/80">{label}</p>
            <p className="max-w-xs text-center text-[11px] text-[#64748b]">
              {voiceMode === 'conversation'
                ? 'Voice-to-voice — কথা বলুন, agent উত্তর দেবে'
                : 'Voice → Bangla text — শেষে auto-send'}
            </p>

            <button
              type="button"
              onClick={onClose}
              className="mt-1 rounded-full border border-black/[0.08] bg-white/90 px-4 py-1.5 text-xs font-medium text-[#64748b] shadow-sm hover:bg-white"
            >
              বন্ধ করুন
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
