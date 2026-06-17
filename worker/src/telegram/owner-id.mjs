/**
 * Owner Telegram chat ID — MUST be read at runtime, not module load.
 * worker/src/index.mjs loads dotenv after ESM imports resolve; caching env at
 * top-level breaks isOwner() and blocks all approve buttons.
 */
export function getOwnerChatId() {
  return String(process.env.TELEGRAM_OWNER_CHAT_ID ?? '').trim()
}

export function isOwnerChatId(chatId) {
  const ownerId = getOwnerChatId()
  return Boolean(ownerId && String(chatId) === ownerId)
}
