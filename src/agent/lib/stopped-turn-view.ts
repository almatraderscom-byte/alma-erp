/**
 * Owner Stop has no authoritative assistant message: canceled heads deliberately
 * persist nothing. Keeping the in-flight bubble would preserve unverified prose
 * (and possibly an ask card) that the server has explicitly revoked.
 */
export function removeStoppedAssistantDraft<
  T extends { role: string; streaming?: boolean },
>(messages: readonly T[]): T[] {
  return messages.filter((message) => !(message.role === 'assistant' && message.streaming === true))
}
