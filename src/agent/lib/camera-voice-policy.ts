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

/**
 * How far into the transcript the wake word may start and still count. Staff
 * ADDRESS the camera first ("আলমা শোনো, …"), so a genuine wake sits at the very
 * front — after at most a short greeting. A wake word appearing deep inside a
 * long sentence is almost always noise / an STT hallucination, and forwarding it
 * is exactly the spam that ran up the owner's cost. Owner-tunable via the
 * `leadChars` argument (KV 'camera_wake_lead_chars' at the call site).
 */
export const DEFAULT_WAKE_LEAD_CHARS = 24

/**
 * Unicode word-boundary wake matching; "alma" never matches "Salma". The match
 * must also LEAD the utterance — start within `leadChars` characters — so only
 * speech actually addressed to the camera wakes it.
 */
export function matchCameraWake(
  transcript: string,
  wakeWords: string[],
  leadChars: number = DEFAULT_WAKE_LEAD_CHARS,
): string | null {
  for (const wakeWord of wakeWords) {
    const words = wakeWord.trim().split(/\s+/).filter(Boolean)
    if (words.length === 0) continue
    const phrase = words.map(escapeRegex).join('\\s+')
    const matcher = new RegExp(`(^|[^\\p{L}\\p{N}])(${phrase})(?![\\p{L}\\p{N}])`, 'iu')
    const match = matcher.exec(transcript)
    if (!match) continue
    // Position of the wake phrase itself (skip the leading boundary group).
    const wakeStart = match.index + match[1].length
    if (wakeStart > leadChars) continue
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
