export type LiveArtifactCard = {
  id: string
  title: string
  type: string
}

/**
 * Normalize a tool-returned card at the one live emission boundary.
 *
 * A durable outbox card is already present in conversation history under its
 * canonical message. Repeated check callbacks must not append another file
 * timeline item or artifact_saved SSE event. Cards without that explicit flag
 * keep the existing live-only behavior (including save_artifact).
 */
export function liveArtifactCard(value: unknown): LiveArtifactCard | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const card = value as Record<string, unknown>
  if (card.canonicalMessageDelivered === true) return null
  if (typeof card.id !== 'string' || typeof card.title !== 'string') return null
  return {
    id: card.id,
    title: card.title,
    type: typeof card.type === 'string' ? card.type : 'markdown',
  }
}
