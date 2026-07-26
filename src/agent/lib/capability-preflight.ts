/**
 * Turn-start capability preflight (owner-observed defect 2026-07-26).
 *
 * Boss asked the agent to write alt-text on almatraders.com. It could not: the
 * preview environment had WEBSITE_SUPABASE_SERVICE_ROLE_KEY but not
 * WEBSITE_SUPABASE_URL, so every website read/write tool was dead. The head
 * still spent 15 steps, 1m36s and three separate tools discovering that one
 * tool at a time — get_website_catalog, then run_website_seo_audit, then
 * audit_product_seo — before finally reporting the blocker.
 *
 * A person with a broken tool says so in the first sentence. This block tells
 * the head, BEFORE its first step, which capabilities are currently dead and
 * exactly which env var is missing — so the answer is one honest line instead of
 * a paid tour of the failure.
 *
 * Design notes:
 *  - It only appears when a dead capability's tools are actually in this turn's
 *    tool list. An unrelated turn gets no extra bytes and no cache disturbance.
 *  - It reports; it does not gate. The tools keep their own guards, and if the
 *    config comes back mid-session the block simply disappears.
 */
import { websiteSupabaseMissingVars } from '@/lib/website/supabase-client'

export interface DeadCapability {
  /** Stable id, used in tests and logs. */
  id: string
  /** Plain-Bangla name of what stops working. */
  label: string
  /** Tools that cannot succeed while this capability is down. */
  tools: string[]
  /** What is missing, in the owner's terms. */
  reason: string
  /** What the owner has to do — named exactly, so he can act without asking. */
  fix: string
}

/** Website Supabase backs every storefront read AND every storefront write. */
const WEBSITE_TOOLS = [
  'get_website_catalog',
  'get_website_health',
  'audit_product_seo',
  'draft_seo_fixes',
  'update_product_web',
  'publish_product',
  'unpublish_product',
  'set_product_featured',
]

/** Capabilities that are down right now, judged from the live environment. */
export function deadCapabilities(): DeadCapability[] {
  const out: DeadCapability[] = []

  const missingWebsite = websiteSupabaseMissingVars()
  if (missingWebsite.length > 0) {
    out.push({
      id: 'website_supabase',
      label: 'ওয়েবসাইটের ডাটাবেস (almatraders.com)',
      tools: WEBSITE_TOOLS,
      reason: `${missingWebsite.join(' + ')} সেট করা নেই`,
      fix: `Vercel-এ এই environment-এর জন্য ${missingWebsite.join(' ও ')} বসাতে হবে`,
    })
  }

  return out
}

/**
 * The directive, or '' when nothing relevant is down. `activeToolNames` is the
 * turn's FINAL shipped tool list — a capability the head cannot reach anyway is
 * not worth a single token. Omit it on a path that builds the prompt before the
 * tool list exists; then every dead capability is reported.
 */
export function capabilityPreflightBlock(activeToolNames?: string[]): string {
  const shipped = activeToolNames ? new Set(activeToolNames) : null
  const inTurn = (t: string) => (shipped ? shipped.has(t) : true)
  const relevant = deadCapabilities().filter((c) => c.tools.some(inTurn))
  if (relevant.length === 0) return ''

  const lines = relevant.map(
    (c) => `- ${c.label} — ${c.reason}। অচল টুল: ${c.tools.filter(inTurn).join(', ')}। সমাধান: ${c.fix}।`,
  )

  return [
    '## এখন যে হাতিয়ারগুলো অচল',
    ...lines,
    '',
    'নিয়ম: এই টুলগুলো এখন কাজ করবে না — একটার পর একটা চেষ্টা করে সময় ও টাকা নষ্ট কোরো না,',
    'ঘুরপথও খুঁজো না। Boss-এর কাজটা যদি এগুলোর উপর নির্ভর করে, তাহলে প্রথম উত্তরেই',
    'সোজা বলো কোনটা অচল, কেন, আর ঠিক কোন সেটিংটা লাগবে — তারপর থামো। কনটেন্ট আগেভাগে',
    'বানিয়ে রেখো না; সেভ করা না গেলে ওটা শুধু খরচ।',
  ].join('\n')
}
