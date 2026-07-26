/**
 * SK-0/SK-1 — the owner's real messages, as he actually types them.
 *
 * Owner rule (2026-07-26): test the way HE would send it. One plain sentence,
 * no tool names, no step list. *"ami just normal kaj ta bolbe erpor agent nije
 * shob kichu korbe."* A corpus written in coached, agent-flavoured English would
 * measure nothing.
 *
 * `expected` is the skill that SHOULD be pinned. `null` means no skill applies —
 * a pick there is a false trigger, which the research says is worse than no
 * skill at all (it removes the tools the real job needed).
 *
 * `note` records what the message is really testing, so a failure is readable.
 */

export interface OwnerCase {
  id: string
  text: string
  expected: string | null
  note?: string
}

export const OWNER_CORPUS: OwnerCase[] = [
  // ── The distinction that cost a day this week ────────────────────────────
  {
    id: 'seo-fix-alt',
    text: 'almatraders.com এর ছবির alt ঠিক করো',
    expected: 'seo-fixing-own-site',
    note: 'FIX order. Must not route to the audit skill.',
  },
  {
    id: 'seo-audit-full',
    text: 'almatraders.com এর পূর্ণাঙ্গ SEO অডিট করো',
    expected: 'seo-auditing-own-site',
    note: 'AUDIT order. The mirror image of the case above.',
  },
  {
    id: 'seo-fix-meta',
    text: 'product-code-110 এর meta description লিখে দাও',
    expected: 'seo-fixing-own-site',
    note: 'Fix order that never says the word SEO.',
  },
  {
    id: 'seo-client',
    text: 'client er site example.com er seo dekho',
    expected: 'seo-fixing-client-site',
    note: 'Someone else’s site — different tools, no DB access.',
  },

  // ── Everyday business, each a different skill ────────────────────────────
  { id: 'staff', text: 'Mustahid ajke kokhon asche?', expected: 'alma-staff-dispatch' },
  { id: 'listing', text: 'notun panjabi ta website e tolo', expected: 'alma-product-listing' },
  { id: 'finance', text: 'ei masher khoroch koto holo?', expected: 'alma-finance-brief' },
  { id: 'cs', text: 'customer der message gulor reply dao', expected: 'alma-customer-support' },
  { id: 'social', text: 'facebook e notun product er post dao', expected: 'alma-product-social-post' },
  { id: 'briefing', text: 'ajker briefing dao', expected: 'alma-owner-daily-briefing' },
  { id: 'marketing', text: 'marketing kemon cholche?', expected: 'alma-marketing' },
  { id: 'campaign', text: 'ekta meta campaign chalu koro 5000 takar', expected: 'alma-meta-campaign-launch' },
  { id: 'website', text: 'website e ki ki somossa ache?', expected: 'alma-website' },
  { id: 'incident', text: 'agent ta kaj korche na keno, dekho', expected: 'alma-agent-incident-diagnosis' },
  { id: 'invoice', text: 'ei invoice ta ERP te tolo', expected: 'alma-invoice-to-erp' },
  { id: 'audience', text: 'je customer ra beshi kene tader ekta audience banao', expected: 'alma-audience-builder' },
  { id: 'browser', text: 'chrome khule daraz e dekho dam koto', expected: 'alma-browser-operator' },
  { id: 'research', text: 'competitor ra ki dame bikri korche khuje dekho', expected: 'alma-research' },

  // ── Must pick NOTHING. A false trigger costs tools the job needed. ───────
  { id: 'greeting', text: 'valo acho?', expected: null },
  { id: 'weather', text: 'ajke bristi hobe?', expected: null },
  { id: 'thanks', text: 'thanks bhai', expected: null },
  { id: 'orders', text: 'kalker order gulo dekhao', expected: null, note: 'Plain ERP read — no procedure needed.' },
  { id: 'sales', text: 'ajker sale koto?', expected: null, note: 'Plain ERP read.' },
  { id: 'yes', text: 'ha koro', expected: null, note: 'Continuation — the pinned skill should carry, not a fresh pick.' },
]
