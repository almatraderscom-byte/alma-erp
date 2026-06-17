/** Fetch TTS audio from server, return an HTMLAudioElement ready to play. */
import { prepareBanglaTtsText } from '@/agent/lib/voice-bangla'

export async function fetchTtsAudio(text: string): Promise<HTMLAudioElement> {
  const clean = prepareBanglaTtsText(text.replace(/\s+/g, ' ').trim()).slice(0, 1200)
  if (!clean) throw new Error('empty text')

  const res = await fetch('/api/assistant/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: clean }),
  })
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(data.error ?? `TTS HTTP ${res.status}`)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const audio = new Audio(url)
  audio.onended = () => URL.revokeObjectURL(url)
  audio.onerror = () => URL.revokeObjectURL(url)
  return audio
}
