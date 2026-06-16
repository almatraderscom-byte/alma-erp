/** ElevenLabs-style orb agent states. */
export type AgentOrbState = null | 'listening' | 'thinking' | 'talking'

/**
 * off — normal text chat
 * dictation — mic → Bangla text in composer (optional auto-send)
 * conversation — full voice session: speak → agent → TTS reply (ChatGPT app style)
 */
export type VoiceMode = 'off' | 'dictation' | 'conversation'

export const ORB_COLORS: [string, string] = ['#F6D5C8', '#E07A5F']
