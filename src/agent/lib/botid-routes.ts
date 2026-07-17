export const ASSISTANT_BOTID_PROTECTED_ROUTES = [
  { path: '/api/assistant/chat', method: 'POST' },
  { path: '/api/assistant/turn', method: 'POST' },
  { path: '/api/assistant/transcribe', method: 'POST' },
  { path: '/api/assistant/stt-session', method: 'POST' },
  { path: '/api/assistant/tts', method: 'POST' },
] as const
