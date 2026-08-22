export const MEDIA_PLAYBACK_UNVERIFIED = 'media_playback_unverified'

export function isHardVerificationReplacement(categories: readonly unknown[]): boolean {
  return categories.includes(MEDIA_PLAYBACK_UNVERIFIED)
}

/** Reset the non-stream/Telegram accumulator before the verified rewrite. */
export function verificationRetryBaseText(
  preambleText: string,
  categories: readonly unknown[],
): string {
  if (isHardVerificationReplacement(categories)) return ''
  return preambleText ? `${preambleText}\n\n` : ''
}

/** Mark exactly the text the live UI must stop rendering after a retry. */
export function supersedeVerificationTimeline<T extends { t: string }>(
  source: readonly T[],
  categories: readonly unknown[],
): Array<T & { state?: 'superseded' }> {
  const timeline = source.map((entry) => ({ ...entry })) as Array<T & { state?: 'superseded' }>
  if (isHardVerificationReplacement(categories)) {
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i].t === 'text') timeline[i] = { ...timeline[i], state: 'superseded' }
    }
    return timeline
  }
  // Ordinary self-correction keeps the leading preamble and supersedes only
  // the latest draft text after it (the established owner-facing behavior).
  for (let i = timeline.length - 1; i >= 1; i--) {
    if (timeline[i].t === 'text') {
      timeline[i] = { ...timeline[i], state: 'superseded' }
      break
    }
  }
  return timeline
}
