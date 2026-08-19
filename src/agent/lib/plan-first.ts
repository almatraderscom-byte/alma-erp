/**
 * Plan before work, on a big job — owner ask 2026-07-26.
 *
 * *"ami jodi tmk ei seo audit fix korte ditam, tmi age etar jnne nije ekta full
 * plan ready korte, erpor amk ek sathe ei full fix er jnne tmr joto question ba
 * approve lagle … age theke confirm hoye … erpor tmi sei plan moto nije step by
 * step kaj sesh korte."*
 *
 * What he watched instead: a big SEO job dribbled out as twenty-to-thirty-second
 * fragments, each ending in another approval card, with no plan he could see.
 * His complaint is not that it asks — it is that it asks piecemeal, forever.
 *
 * So: the FIRST turn of a big job is a planning turn. One message with the whole
 * shape and every decision needed, then it stops. He answers once. After that it
 * executes without asking again.
 *
 * The guarantee is not the wording. On a planning turn the staging and write
 * tools are simply not in the head's hands — the same lever that made listen
 * mode and the chat modes hold. It cannot half-start the work while "planning".
 *
 * Deliberately narrow: only the FIRST deep-work turn of a conversation that has
 * never staged anything. The moment a card exists, planning is over and this
 * never fires again in that chat.
 */
import { prisma } from '@/lib/prisma'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = prisma as any

/** Tools a planning turn must NOT hold — anything that stages or changes work. */
export const PLAN_TURN_WITHHELD = new Set([
  'draft_seo_fixes',
  'update_product_web',
  'publish_product',
  'unpublish_product',
  'set_product_featured',
  'submit_to_indexnow',
  'schedule_content',
  'schedule_content_batch',
  'draft_marketing_campaign',
  'launch_campaign',
  'dispatch_staff_tasks',
  'send_customer_message',
  'execute_plan',
])

export function filterToolsForPlanTurn<T extends { name: string }>(tools: T[]): {
  tools: T[]
  removed: string[]
} {
  const kept = tools.filter((t) => !PLAN_TURN_WITHHELD.has(t.name))
  return { tools: kept, removed: tools.filter((t) => PLAN_TURN_WITHHELD.has(t.name)).map((t) => t.name) }
}

/**
 * Is this the planning turn for a big job?
 *
 * Requires ALL of: Boss asked for deep/whole-scope work, and this conversation
 * has never staged a pending action. Reading tools stay available, because a
 * plan written without looking at the real numbers is worthless — he wants the
 * scope counted, not guessed.
 */
export async function isPlanFirstTurn(input: {
  conversationId: string
  deepWork: boolean
}): Promise<boolean> {
  if (!input.deepWork) return false
  try {
    const staged = await db.agentPendingAction.count({ where: { conversationId: input.conversationId } })
    return staged === 0
  } catch {
    // Fail open to normal work: a DB hiccup must never block Boss's job behind a
    // planning turn he did not ask for.
    return false
  }
}

/**
 * The contract for a planning turn. Explicit about the ONE thing he was most
 * annoyed by — being asked again later for things that could have been settled
 * here.
 */
export function planFirstNote(): string {
  return (
    '[SERVER REQUIREMENT — planning turn]\n'
    + '• এটা বড় কাজ, আর এটা তোমার **পরিকল্পনার টার্ন**। এই টার্নে কোনো কাজ শুরু কোরো না, '
    + 'কোনো approval card বানিও না — ওই টুলগুলো এখন তোমার হাতেই নেই।\n'
    + '• আগে পড়ার টুল দিয়ে **আসল মাপটা নাও** (কতগুলো, কোনগুলো) — অনুমানে প্ল্যান লিখো না।\n'
    + '• তারপর একটা মেসেজেই দাও: (১) ধাপে ধাপে প্ল্যান, (২) মোট কত সময়/কত ব্যাচ লাগবে, '
    + '(৩) Boss-এর কাছ থেকে তোমার **সব** প্রশ্ন ও অনুমতি একসাথে — পরে আর জিজ্ঞেস করার সুযোগ নেই ধরে নাও।\n'
    + '• পরিকল্পনাটা শুধু prose-এ লিখে থেমো না — make_plan দিয়ে durable ধাপ বানাও, যাতে Boss এখনই tracker-এ পুরো তালিকা দেখতে পান।\n'
    + '• Boss একবার সায় দিলে তুমি পুরো প্ল্যান নিজে শেষ করবে, প্রতিটা ধাপের পর সংক্ষেপে জানাবে, '
    + 'আর ছোট ছোট বিষয়ে বারবার অনুমতি চাইবে না।'
  )
}
