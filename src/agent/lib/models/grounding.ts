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
 * Cannot evidence work on Boss's request, whatever else they are good for.
 *
 * A clock read, a memory search and a tool lookup answer questions about the
 * AGENT, not about the thing that was asked. `find_tool` belongs here for the
 * same reason it exists: it is the step before the read, never the read.
 *
 * The second group is the rest of CORE_PACK — the tools shipped on EVERY turn
 * regardless of what was asked (Codex P2). Leaving them out made a denylist
 * that a forced round could discharge with `ask_user` or
 * `get_pending_approvals` and never read the requested data at all; `ask_user`
 * is the worst of them, because staging a card strips the tools from the next
 * iteration. Anything always present must never count as evidence that THIS
 * question was worked on.
 *
 * A positive list of "relevant reads" would be stricter still, but it needs a
 * per-domain mapping of question → tools that does not exist yet, and getting
 * it wrong fails CLOSED (a turn that can never satisfy grounding). This list
 * plus MAX_GROUNDING_FORCE_ROUNDS fails open, which is the right direction
 * while the mapping is still being built.
 */
export const SHALLOW_GROUNDING_TOOLS: ReadonlySet<string> = new Set([
  ...BOOKKEEPING_TOOLS,
  'get_current_datetime', 'find_tool', 'search_memory', 'recall_business_knowledge',
  'ask_user', 'get_pending_approvals', 'delegate_to_specialist',
  'request_standing_permission', 'resolve_open_task',
])

/**
 * Did this turn attempt anything that bears on what Boss asked?
 *
 * The same question as grounding, asked of the incapacity verifier: a reply
 * that pleads "no browser tool is connected" must not be excused because the
 * model happened to read the clock first (Codex P2). Attempt counts failures
 * too — a call that ran and errored is evidence, and the honesty rules for that
 * case already exist.
 */
export function hasSubstantiveToolAttempt(records: readonly GroundingToolRecord[]): boolean {
  return records.some((r) => !SHALLOW_GROUNDING_TOOLS.has(r.toolName))
}

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
  /** Present for the operation check in hasSuccessfulLook. */
  input?: unknown
}

/** True once a tool that could actually answer the question has succeeded. */
export function isGroundingSatisfied(records: readonly GroundingToolRecord[]): boolean {
  return records.some((r) => r.status === 'success' && !SHALLOW_GROUNDING_TOOLS.has(r.toolName))
}

/**
 * Did a tool that can actually SEE the claimed surface succeed?
 *
 * Stricter than isGroundingSatisfied, and deliberately so (Codex P1): a
 * successful `mac_agent_status` or `get_orders` satisfies grounding, but neither
 * looked at a screen — so accepting them would let "Maxstream-এর পেজ খোলা আছে"
 * ride on a status ping. Sight claims need an eye.
 *
 * Matched by pattern as well as by name so a newly added camera/screenshot tool
 * is covered on the day it ships rather than the day someone remembers this list.
 */
/**
 * The OPERATION decides, not the name (Codex P1). `camera_speak` contains
 * "camera" and only queues audio; `mac_desk_control` also does keep_awake,
 * allow_sleep and power_status, none of which return an image. Matching on the
 * name alone let a fabricated screen reading ride on any of them.
 */
const LOOK_ACTIONS: Record<string, ReadonlySet<string> | true> = {
  mac_desk_control: new Set(['screenshot']),
  look_mac_app: new Set(['tree', 'screenshot', 'scroll', 'session']),
  get_office_camera_snapshot: true,
  live_browser_look: true,
  read_screenshot: true,
  qc_inspect_photo: true,
  get_staff_location: true,
}

export function hasSuccessfulLook(records: readonly GroundingToolRecord[]): boolean {
  return records.some((r) => {
    if (r.status !== 'success') return false
    const allowed = LOOK_ACTIONS[r.toolName]
    if (allowed === undefined) return false
    if (allowed === true) return true
    const action = (r.input as { action?: unknown } | undefined)?.action
    return typeof action === 'string' && allowed.has(action)
  })
}

/** The successful reads that did the grounding — persisted for measurement. */
export function groundingEvidence(records: readonly GroundingToolRecord[]): string[] {
  return records
    .filter((r) => r.status === 'success' && !SHALLOW_GROUNDING_TOOLS.has(r.toolName))
    .map((r) => r.toolName)
}
