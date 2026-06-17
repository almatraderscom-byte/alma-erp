/**
 * Default-deny: any callback not in STAFF_ALLOWED requires owner chat ID.
 * Worker internal token calls Vercel as owner — Telegram callbacks must not be staff-elevatable.
 */
import { isOwnerChatId } from './owner-id.mjs'

/** Staff may use these prefixes without owner check. */
const STAFF_CALLBACK_PREFIXES = [
  'task_done:',
  'msg_ack:',
  'staff_feedback_open:',
]

const STAFF_CALLBACK_EXACT = new Set([
  'msg_ack_done',
  'leave_request',
])

export function isStaffAllowedCallback(data) {
  if (!data) return false
  if (STAFF_CALLBACK_EXACT.has(data)) return true
  return STAFF_CALLBACK_PREFIXES.some((p) => data.startsWith(p))
}

/** True when this callback must be owner-only. */
export function isOwnerOnlyCallback(data) {
  if (!data) return false
  if (isStaffAllowedCallback(data)) return false
  // All other callback_query data is owner-privileged (approvals, finance, proposals, salah, etc.)
  return true
}

/**
 * @returns {Promise<boolean>} true if handler should continue
 */
export async function guardOwnerCallback(ctx) {
  const data = ctx.callbackQuery?.data ?? ''
  if (!isOwnerOnlyCallback(data)) return true
  const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat?.id
  if (isOwnerChatId(chatId)) return true
  try {
    await ctx.answerCbQuery('অনুমতি নেই — শুধু Owner')
  } catch { /* ignore */ }
  return false
}
