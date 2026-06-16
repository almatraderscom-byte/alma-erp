/** Client-side TTS playback for voice conversation mode. */

export async function speakAgentText(text: string): Promise<HTMLAudioElement> {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 1200)
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
  await audio.play()
  return audio
}
