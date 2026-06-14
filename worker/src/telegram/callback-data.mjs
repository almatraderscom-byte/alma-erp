/**
 * Telegram inline button callback_data — hard limit 64 bytes (UTF-8).
 * @see https://core.telegram.org/bots/api#inlinekeyboardbutton
 */

export const TELEGRAM_CALLBACK_MAX_BYTES = 64

export function compactUuid(uuid) {
  return String(uuid ?? '').replace(/-/g, '')
}

/** Restore standard UUID form from 32-char hex (task_done compact ids). */
export function parseTaskIdFromCallback(raw) {
  const id = String(raw ?? '').split(':')[0].trim()
  if (/^[0-9a-f]{32}$/i.test(id)) {
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`
  }
  return id
}

export function callbackDataBytes(data) {
  return Buffer.byteLength(String(data), 'utf8')
}

/** Join with ':' and throw before Telegram returns BUTTON_DATA_INVALID. */
export function buildCallbackData(...parts) {
  const data = parts.map((p) => String(p)).join(':')
  const bytes = callbackDataBytes(data)
  if (bytes > TELEGRAM_CALLBACK_MAX_BYTES) {
    throw new Error(
      `callback_data ${bytes} bytes exceeds Telegram max ${TELEGRAM_CALLBACK_MAX_BYTES}: ${data.slice(0, 52)}…`,
    )
  }
  return data
}

export function taskDoneCallbackData(taskId) {
  return buildCallbackData('task_done', compactUuid(taskId))
}

export function msgAckCallbackData(outboxId) {
  return buildCallbackData('msg_ack', compactUuid(outboxId))
}
