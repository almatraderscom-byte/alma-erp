/**
 * Single-task Bangla "how to do it" explanation — the engine behind the office
 * group-chat "আজকের কাজ" button. A staff taps a task they don't understand and
 * the agent explains THAT one task, once, in simple Bangla. Cheap (Gemini, never
 * Claude) and owner-approval-free by the owner's explicit decision: explaining a
 * task the staff was already assigned carries no risk, so it posts straight away.
 *
 * Kept in its own tiny module (imports only gemini-text + staff-task-format) so
 * the chat route and office-staff can use it WITHOUT pulling in the heavy
 * `staff-tools.ts` tool registry — which would form an import cycle.
 */
import { geminiGenerateText } from '@/agent/lib/gemini-text'
import { buildStaffFriendlyDetail } from '@/agent/lib/staff-task-format'

const STAFF_TASK_EXPLAIN_TOOL_HINT: Record<string, string> = {
  video_reel: 'CapCut',
  ad_creative: 'Canva',
  product_content: 'Canva / FB',
  product_photo: 'ফোন ক্যামেরা',
  listing_update: 'Website admin',
  order_followup: 'ERP + ফোন/মেসেঞ্জার',
  page_management: 'FB Page admin',
  customer_reply: 'Messenger',
  stock_check: 'ERP inventory',
}

/** A short, mostly-numeric SKU/code (e.g. "133", "A12") — not a full product name. */
function isProductCode(ref: string | null | undefined): ref is string {
  const r = (ref ?? '').trim()
  return r.length > 0 && r.length <= 8 && /\d/.test(r) && /^[A-Za-z0-9-]+$/.test(r)
}

/**
 * True when the task has a code-like productRef but the generated explanation does
 * NOT contain that exact code — the tell-tale sign a cheap model invented a
 * different product code. We then fall back to the deterministic template, which
 * only ever uses the real productRef. Correctness of the code beats a prettier line.
 */
function productCodeMismatch(productRef: string | null | undefined, text: string): boolean {
  if (!isProductCode(productRef)) return false
  const re = new RegExp(`(^|[^A-Za-z0-9])${productRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`)
  return !re.test(text)
}

/**
 * Build a 3–4 line simple-Bangla explanation of ONE task for a staff member.
 * Falls back to the deterministic template on any model error or product-code
 * mismatch, so the caller always gets usable text.
 */
export async function buildStaffTaskExplanation(opts: {
  staffName: string
  title: string
  type: string
  detail: string | null
  productRef: string | null
  extraContext?: string
  conversationId?: string | null
}): Promise<string> {
  const fallback = () =>
    buildStaffFriendlyDetail({ title: opts.title, type: opts.type, productRef: opts.productRef, detail: null })

  const toolHint = STAFF_TASK_EXPLAIN_TOOL_HINT[opts.type] ?? 'ERP'
  const prompt = [
    'তুমি ALMA টিমের একজন সহকারী ম্যানেজার। নিচের কাজটি একজন স্টাফকে খুব সহজ বাংলায় বুঝিয়ে দাও —',
    'যেন কম শিক্ষিত স্টাফও পড়ে নিজে নিজে করতে পারে।',
    '',
    `স্টাফের নাম: ${opts.staffName}`,
    `কাজ: ${opts.title}`,
    `ধরন: ${opts.type}`,
    opts.productRef ? `প্রোডাক্ট: ${opts.productRef}` : '',
    opts.detail ? `আগের নোট: ${opts.detail}` : '',
    opts.extraContext ? `বাড়তি নির্দেশ: ${opts.extraContext}` : '',
    '',
    'নিয়ম:',
    '- ৩–৪ লাইনের বেশি নয়। প্রতিটি লাইন ছোট ও পরিষ্কার ধাপ।',
    `- কোন অ্যাপ/টুল দিয়ে করবে স্পষ্ট বলো (এই কাজে: ${toolHint})।`,
    '- জটিল শব্দ নয়, ইংরেজি কম। শেষে proof/Done-এর কথা মনে করিয়ে দাও।',
    '- কোনো হারাম পণ্য/ছবির ইঙ্গিত নয়। শুধু কাজের ধাপ লেখো, ভূমিকা বা অভিবাদন নয়।',
    opts.productRef
      ? `- প্রোডাক্ট কোড হুবহু "${opts.productRef}" লিখবে। কখনো নিজে থেকে অন্য কোনো নম্বর/কোড বানাবে না বা বদলাবে না।`
      : '',
  ]
    .filter(Boolean)
    .join('\n')

  let text: string
  try {
    text = await geminiGenerateText({
      prompt,
      costLabel: 'staff_task_explain',
      maxTokens: 400,
      temperature: 0.4,
      conversationId: opts.conversationId,
    })
  } catch {
    return fallback()
  }

  // Keep it to at most 4 non-empty lines so it reads as a tight step list.
  const cleaned = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join('\n')

  if (!cleaned || productCodeMismatch(opts.productRef, cleaned)) return fallback()
  return cleaned
}
