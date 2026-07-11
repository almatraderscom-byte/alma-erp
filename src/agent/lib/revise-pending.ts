/**
 * Owner-feedback revise flow for pending approval cards.
 *
 * Today an approval card gives the owner exactly two choices: Approve or Reject.
 * When a card is *almost* right but needs a tweak ("দুইজনকে না, শুধু রাকিবকে দাও",
 * "দামটা ৮০০ করো", "ক্যাপশনে অফারটা যোগ করো") the owner has to abandon the card,
 * open chat, re-explain the whole thing and burn a full context reload + several
 * messages. This module powers a THIRD option — the owner types his opinion right
 * on the card and the head re-edits THAT pending card in place, then confirms.
 *
 * Design: we do NOT rewrite typed payloads from a REST handler (dispatch tasks live
 * in `agent_staff_tasks` rows, finance in typed batch payloads, etc. — each card
 * type stores its truth differently). Instead the feedback is persisted as an owner
 * turn and the HEAD runs one scoped turn, using the SAME edit tools it already owns
 * (merge_into_proposal, redraft, finance edits …). One source of truth, no per-type
 * rewrite logic duplicated here.
 */

/**
 * Card types where a free-text "amar motamot" revise is safe — the head has an
 * in-place edit path (or a clean redraft/supersede) for each. Deliberately EXCLUDES
 * finance/ledger cards (they already expose a structured field editor via
 * POST /api/assistant/actions/[id]), settings, reminders, and image/video gen where
 * a natural-language rewrite would be ambiguous or risky. Owner decision 2026-07-08:
 * ship the safe set first.
 */
export const REVISABLE_ACTION_TYPES = new Set<string>([
  'dispatch_staff_tasks',
  'delegation',
  'send_customer_message',
  'staff_announcement',
  'fb_post',
  'instagram_post',
  'marketing_plan',
  'content_gate1',
  'content_gate2',
  'ad_creative_gate',
])

export function isRevisableAction(type?: string | null): boolean {
  return !!type && REVISABLE_ACTION_TYPES.has(type)
}

/**
 * The synthetic owner turn we persist + feed to the head. It pins the head to
 * editing THIS specific pending card (not spinning up an unrelated task), tells it
 * to keep the card pending for a final Boss approve, and to answer with one short
 * Bangla confirmation line of what changed.
 */
export function buildReviseDirective(args: {
  id: string
  type: string
  summary: string
  feedback: string
}): string {
  const summary = (args.summary ?? '').trim()
  return (
    `[BOSS-এর মতামত — pending কার্ড রিভাইজ করো]\n` +
    `Boss নিচের অনুমোদন-অপেক্ষমাণ কার্ডটা দেখে একটা মতামত দিয়েছেন। কার্ডটা approve/reject না করে ` +
    `তোমার এডিট টুল দিয়ে ঠিক এই কার্ডটাই Boss-এর কথামতো রিভাইজ করো, এবং কার্ডটা pending রেখে দাও ` +
    `যেন Boss শেষে নিজে Approve করতে পারেন। নতুন অপ্রাসঙ্গিক কাজ শুরু করবে না।\n\n` +
    `কার্ড টাইপ: ${args.type}\n` +
    `কার্ড আইডি: ${args.id}\n` +
    `বর্তমান কার্ড:\n${summary || '(সারাংশ নেই)'}\n\n` +
    `Boss-এর মতামত: ${args.feedback.trim()}\n\n` +
    `রিভাইজ শেষে Boss-কে এক লাইনে বাংলায় জানাও কী পরিবর্তন করলে (emoji নয়)। এখনই কার্ড কার্যকর কোরো না।`
  )
}
