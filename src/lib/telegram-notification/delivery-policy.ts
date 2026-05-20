/** Classify Telegram API failures for queue retry decisions. */

export type TelegramFailureClass = 'retryable' | 'permanent'

export function parseTelegramErrorCode(errorMessage?: string | null, errorCode?: number): number | null {
  if (typeof errorCode === 'number' && Number.isFinite(errorCode)) return errorCode
  if (!errorMessage) return null
  const match = errorMessage.match(/^(\d{3}):/)
  if (match) return Number(match[1])
  return null
}

export function classifyTelegramDeliveryFailure(
  errorMessage?: string | null,
  errorCode?: number,
): TelegramFailureClass {
  const code = parseTelegramErrorCode(errorMessage, errorCode)
  const msg = (errorMessage || '').toLowerCase()

  if (msg.includes('telegram_bot_token_missing')) return 'permanent'
  if (msg.includes('delivery_exception_timeout') || msg.includes('_timeout')) return 'retryable'
  if (msg.includes('abort') || msg.includes('fetch failed') || msg.includes('econnreset') || msg.includes('network')) {
    return 'retryable'
  }

  if (code === 429) return 'retryable'
  if (code != null && code >= 500) return 'retryable'

  if (code === 403) return 'permanent'
  if (code === 400) return 'permanent'
  if (code === 401) return 'permanent'

  if (
    msg.includes('bot was blocked')
    || msg.includes('chat not found')
    || msg.includes('user is deactivated')
    || msg.includes("can't parse")
    || msg.includes('wrong file')
    || msg.includes('invalid chat')
  ) {
    return 'permanent'
  }

  return 'permanent'
}

export function isTelegramDeliveryRetryable(errorMessage?: string | null, errorCode?: number): boolean {
  return classifyTelegramDeliveryFailure(errorMessage, errorCode) === 'retryable'
}
