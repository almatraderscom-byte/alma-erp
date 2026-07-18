export type CameraRoom = 'workroom' | 'entrance' | 'boss'

const ROOM_ALIASES: Record<string, CameraRoom> = {
  work: 'workroom',
  workroom: 'workroom',
  'কাজ': 'workroom',
  entrance: 'entrance',
  gate: 'entrance',
  'গেট': 'entrance',
  'ঢোকার': 'entrance',
  boss: 'boss',
  'বস': 'boss',
  'মালিক': 'boss',
}

const ROOM_LABELS: Record<CameraRoom, string> = {
  workroom: 'ওয়ার্করুম',
  entrance: 'এন্ট্রান্স',
  boss: 'বস অফিস',
}

export function canonicalCameraRoom(value?: string): CameraRoom {
  return ROOM_ALIASES[(value ?? '').trim().toLowerCase()] ?? 'workroom'
}

export function cameraRoomLabel(value?: string): string {
  return ROOM_LABELS[canonicalCameraRoom(value)]
}

export function cameraCooldownKey(value?: string): string {
  return `camera_listen_last_forward_at:${canonicalCameraRoom(value)}`
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Unicode word-boundary wake matching; "alma" no longer matches "Salma". */
export function matchCameraWake(transcript: string, wakeWords: string[]): string | null {
  for (const wakeWord of wakeWords) {
    const words = wakeWord.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    const phrase = words.map(escapeRegex).join('\\s+')
    const matcher = new RegExp(`(^|[^\\p{L}\\p{N}])(${phrase})(?![\\p{L}\\p{N}])`, 'iu')
    const match = matcher.exec(transcript)
    if (!match) continue
    const after = transcript.slice(match.index + match[0].length)
    return after.replace(/^[\s,।:;-]+/, '').trim()
  }
  return null
}

export function declaredAudioTooLarge(contentLength: string | null, maxBytes: number): boolean {
  if (!contentLength) return false
  const bytes = Number(contentLength)
  return Number.isFinite(bytes) && bytes > maxBytes
}
