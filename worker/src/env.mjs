/**
 * Runtime env accessors — never cache at module load (ESM import order safe).
 */
export function getAppUrl() {
  return String(process.env.APP_URL ?? '').replace(/\/$/, '')
}

export function getInternalToken() {
  return process.env.AGENT_INTERNAL_TOKEN ?? ''
}

export function getBotToken() {
  return process.env.ASSISTANT_BOT_TOKEN ?? ''
}

export function requireAppUrl(label = 'worker') {
  const url = getAppUrl()
  if (!url) throw new Error(`[${label}] APP_URL is not configured`)
  return url
}
