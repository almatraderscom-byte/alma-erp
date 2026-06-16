/**
 * agent_staff column helpers — Postgres mixes camelCase (telegramChatId) and snake_case (ntfy_topic).
 */

/** @param {Record<string, unknown> | null | undefined} row */
export function staffNtfyTopic(row) {
  if (!row) return null
  const topic = row.ntfy_topic ?? row.ntfyTopic
  return typeof topic === 'string' && topic.trim() ? topic.trim() : null
}

/** @param {Record<string, unknown> | null | undefined} row */
export function staffTelegramChatId(row) {
  if (!row) return null
  const id = row.telegramChatId ?? row.telegram_chat_id
  return id != null && String(id).trim() ? String(id).trim() : null
}
