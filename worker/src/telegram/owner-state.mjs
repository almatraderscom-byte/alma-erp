/** In-memory owner session (resets on worker restart — /new recovers). */
export const ownerState = {
  conversationId: null,
  personalConversationId: null,
  financeEdit: null,
}

const ownerTurnInFlight = new Set()

export function isOwnerTurnInFlight(chatId) {
  return ownerTurnInFlight.has(String(chatId))
}

export function markOwnerTurnStart(chatId) {
  ownerTurnInFlight.add(String(chatId))
}

export function releaseOwnerTurn(chatId) {
  ownerTurnInFlight.delete(String(chatId))
}
