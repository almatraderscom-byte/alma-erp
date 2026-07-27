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

  // ── BANGLISH fix orders — the gap he caught live, 2026-07-27 ────────────
  // Every work verb in the rule layer was Bangla SCRIPT only, so "slug thik
  // koro" matched nothing, three skills tied on keyword score, and the
  // READ-ONLY audit skill won a FIX order. He types romanised most of the time;
  // a corpus that only tests the script measures the wrong agent.
  {
    id: 'seo-fix-slug-banglish',
    text: 'almatraders.com er baki slug problem gulo thik kore dao',
    expected: 'seo-fixing-own-site',
    note: 'Romanised fix order, and no seo/alt/meta word anywhere in it.',
  },
  {
    id: 'seo-fix-meta-banglish',
    text: 'almatraders.com er product gulor meta description thik kore dao',
    expected: 'seo-fixing-own-site',
    note: 'The message that actually pinned the right skill — keep it pinned.',
  },
  {
    id: 'seo-audit-banglish',
    text: 'almatraders.com er purno seo audit koro',
    expected: 'seo-auditing-own-site',
    note: 'Romanised AUDIT order — the mirror image, must not flip to fixing.',
  },

  // ── FROM HIS REAL TRAFFIC, 2026-07-27 ───────────────────────────────────
  // Both were found by reading the conversations that actually pinned a skill,
  // not by imagining a message. Both are the expensive failure: a wrong pin also
  // pins a tool allowlist, so the job loses the tools it needed.
  {
    id: 'seo-fix-title-thin',
    text: 'almatraders.com এর পুরো দুর্বল title আর thin description gulo thik koro',
    expected: 'seo-fixing-own-site',
    note:
      'An unmistakable on-page FIX that carries no seo/alt/meta word, so no rule '
      + 'fired and the READ-ONLY audit skill won the tie. Live, twice.',
  },
  {
    id: 'ads-audit-not-seo',
    text: 'amar ads account ta ekbar valo kore audit koro',
    expected: null,
    note:
      'Bare "audit" counted as an SEO topic outright, so an ADS question was '
      + 'handed the SEO audit skill and none of the ads tools. Every audit is '
      + 'not an SEO audit.',
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

  // ── A1: editing a product that is already on the site ───────────────────
  // He names the product and says what should change. No SEO word, no "website"
  // — nothing a keyword score can reach, which is why these are rules.
  {
    id: 'edit-price',
    text: 'ei product tar dam 1200 koro',
    expected: 'storefront-editing',
    note: 'Price on the live site. Must not be read as a new listing.',
  },
  {
    id: 'edit-hide',
    text: 'oi panjabi ta site theke soriye dao',
    expected: 'storefront-editing',
    note: 'Unpublish. The mirror of the listing job, and it is not one.',
  },
  {
    id: 'edit-featured',
    text: 'oita homepage e dekhao',
    expected: 'storefront-editing',
    note: 'Homepage featured row.',
  },

  // ── Must pick NOTHING. A false trigger costs tools the job needed. ───────
  { id: 'greeting', text: 'valo acho?', expected: null },
  { id: 'weather', text: 'ajke bristi hobe?', expected: null },
  { id: 'thanks', text: 'thanks bhai', expected: null },
  { id: 'orders', text: 'kalker order gulo dekhao', expected: null, note: 'Plain ERP read — no procedure needed.' },
  { id: 'sales', text: 'ajker sale koto?', expected: null, note: 'Plain ERP read.' },
  { id: 'yes', text: 'ha koro', expected: null, note: 'Continuation — the pinned skill should carry, not a fresh pick.' },
  {
    id: 'parcel-eta',
    text: 'customer er order ta kokhon asche?',
    expected: null,
    note:
      'The boundary the staff-attendance rule must not cross (2026-07-27). Same '
      + 'words as "Mustahid ajke kokhon asche", different subject — pinning the staff '
      + 'skill here would strip the order tools the answer needs.',
  },
]
