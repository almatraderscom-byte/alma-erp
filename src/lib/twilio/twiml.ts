/** TwiML builders — mirrors proven Hermes /ai-core twilio pattern. */

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Double-play + pause — fixes missed audio on BD mobile networks. */
export function buildSalahCallTwiml(audioUrl: string, sayFallback?: string): string {
  const escaped = escapeXml(audioUrl)
  const say = sayFallback?.trim()
    ? `<Say voice="Polly.Aditi" language="bn-IN">${escapeXml(sayFallback.slice(0, 400))}</Say>`
    : ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Play>${escaped}</Play>` +
    `<Pause length="2"/>` +
    `<Play>${escaped}</Play>` +
    say +
    `</Response>`
  )
}

export function buildSalahCallSayTwiml(text: string): string {
  const escaped = escapeXml(text.slice(0, 400))
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response>` +
    `<Say voice="Polly.Aditi" language="bn-IN">${escaped}</Say>` +
    `<Pause length="1"/>` +
    `<Say voice="Polly.Aditi" language="bn-IN">${escaped}</Say>` +
    `</Response>`
  )
}

/**
 * Message-delivery call (playOnce): audio played exactly once, then hangup.
 * No double-play, no <Say> repetition. Without an audio URL (say-only retry
 * case) a single <Say> + <Hangup/> is returned instead.
 */
export function buildMessageCallTwiml(audioUrl?: string, sayFallback?: string): string {
  if (audioUrl) {
    return (
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<Response><Play>${escapeXml(audioUrl)}</Play><Hangup/></Response>`
    )
  }
  const say = sayFallback?.trim() ?? ''
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<Response><Say voice="Polly.Aditi" language="bn-IN">${escapeXml(say.slice(0, 400))}</Say><Hangup/></Response>`
  )
}

/** opts.once=true → single play + hangup (message-delivery call) */
export function buildTwimlCallbackUrl(
  appUrl: string,
  audioUrl: string,
  sayText?: string,
  opts: { once?: boolean } = {},
): string {
  const base = appUrl.replace(/\/$/, '')
  const params = new URLSearchParams({ audio: audioUrl })
  if (sayText?.trim()) params.set('say', sayText.slice(0, 400))
  if (opts.once) params.set('once', '1')
  return `${base}/api/twilio/twiml/salah-call?${params.toString()}`
}

/** opts.once=true → single say + hangup (message-delivery call) */
export function buildTwimlSayOnlyUrl(
  appUrl: string,
  sayText: string,
  opts: { once?: boolean } = {},
): string {
  const base = appUrl.replace(/\/$/, '')
  const onceParam = opts.once ? '&once=1' : ''
  return `${base}/api/twilio/twiml/salah-call?say=${encodeURIComponent(sayText.slice(0, 400))}${onceParam}`
}
