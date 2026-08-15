/**
 * What counts as having READ the thing Boss asked about.
 *
 * The ground-before-answer rule forces a tool call on round 0 of a live-data
 * question. It was satisfied by ANY successful tool, and the requirement then
 * lapsed because it only looked at round 0 — so on the owner's "Ok audit koro"
 * turn (2026-08-15) a `get_current_datetime` call discharged it and the reply
 * closed with "Ads-এর live tool result পাওয়া যায়নি". Grounding formally
 * satisfied, factually absent.
 *
 * The wire cannot express "required, but from this subset" — OpenAI's
 * tool_choice takes `'required'` or one named function, nothing in between — so
 * the requirement is scoped HERE instead, by deciding which successes count.
 */

/** Bookkeeping: writes state, tells us nothing about the business. */
export const BOOKKEEPING_TOOLS: ReadonlySet<string> = new Set([
  'save_memory', 'update_memory', 'delete_memory', 'graph_remember',
  'save_task_checkpoint', 'track_open_task', 'add_owner_todo', 'manage_work_todos',
])

/**
 * Cannot ground an answer, whatever else they are good for. A clock read, a
 * memory search and a tool lookup answer questions about the AGENT, not about
 * the thing that was asked. `find_tool` belongs here for the same reason it
 * exists: it is the step before the read, never the read.
 */
export const SHALLOW_GROUNDING_TOOLS: ReadonlySet<string> = new Set([
  ...BOOKKEEPING_TOOLS,
  'get_current_datetime', 'find_tool', 'search_memory', 'recall_business_knowledge',
])

/**
 * Consecutive forced grounding rounds. The requirement now survives a shallow
 * tool, so it needs its own ceiling: without one, a model that answers every
 * forced round with another clock read would spin until the iteration budget
 * ran out.
 */
export const MAX_GROUNDING_FORCE_ROUNDS = 2

export interface GroundingToolRecord {
  toolName: string
  status: string
}

/** True once a tool that could actually answer the question has succeeded. */
export function isGroundingSatisfied(records: readonly GroundingToolRecord[]): boolean {
  return records.some((r) => r.status === 'success' && !SHALLOW_GROUNDING_TOOLS.has(r.toolName))
}

/** The successful reads that did the grounding — persisted for measurement. */
export function groundingEvidence(records: readonly GroundingToolRecord[]): string[] {
  return records
    .filter((r) => r.status === 'success' && !SHALLOW_GROUNDING_TOOLS.has(r.toolName))
    .map((r) => r.toolName)
}
