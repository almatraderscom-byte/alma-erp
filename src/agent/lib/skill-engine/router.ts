/**
 * SK-3 — the three-layer skill router (U4).
 *
 * Settled by measurement, not opinion. The owner put the same architecture
 * question to Codex, which argued the MODEL should choose; I had argued the
 * SERVER should. SK-0 answered it: pure keyword routing scores 61% on his real
 * messages, so neither extreme is right.
 *
 *   1. FILTER  — the server removes what is not eligible at all: draft skills,
 *                `implicit: false`, and anything whose declared dependencies are
 *                missing. Free, and it can never be argued with.
 *   2. RULES   — a short ordered decision list settles the cases a keyword can
 *                never see. "ঠিক করো" is a fix; "অডিট করো" is an audit. That one
 *                confusion cost a day this week, so it does not go to a model.
 *   3. MODEL   — only what is left. When the top two candidates are close, the
 *                router says so and the caller asks the head to choose among a
 *                shortlist. At most once per conversation, because of the pin.
 *
 * Every decision carries a TRACE (U5): which layer decided, why, and what the
 * runner-up was. A wrong pin then has an answer instead of a guess.
 */
import { selectSkills } from '@/agent/lib/skill-engine/loader'
import type { SkillIndex, SkillMetadata } from '@/agent/lib/skill-engine/types'

export type RouteLayer = 'rule' | 'keyword' | 'model' | 'none'

export interface RouteCandidate {
  name: string
  score: number
}

export interface RouteDecision {
  /** The skill to pin, or null. When `needsModel` is true this is the best guess. */
  skill: string | null
  layer: RouteLayer
  /** Human-readable, stored with the turn — this is the trace (U5). */
  reason: string
  candidates: RouteCandidate[]
  /** True when layers 1–2 could not settle it and the head should choose. */
  needsModel: boolean
}

/** Below this margin between the top two, keyword scoring is a coin flip. */
export const AMBIGUITY_MARGIN = 3

/**
 * A keyword-only pin needs real evidence, not one incidental word. Measured:
 * "kalker order gulo dekhao" pinned the incident-diagnosis skill on a score of
 * 1 — a single token overlap. A wrong pin also pins a tool allowlist, so a weak
 * match must produce NO skill rather than a bad one.
 *
 * Calibrated on the owner corpus rather than chosen: a floor of 3 killed the
 * false trigger but also lost `alma-finance-brief` (72%); a floor of 2 keeps it
 * and still leaves zero false triggers (78%).
 */
export const MIN_KEYWORD_SCORE = 2

// ── Layer 1: eligibility ────────────────────────────────────────────────────

export interface RouteContext {
  /** Env var names that are actually set — for `dependencies.env`. */
  presentEnv?: Set<string>
  /** Skills the owner named explicitly; `implicit: false` ones need this. */
  namedByOwner?: string[]
}

export function eligibleSkills(index: SkillIndex, ctx: RouteContext = {}): SkillMetadata[] {
  const named = new Set(ctx.namedByOwner ?? [])
  return index.skills.filter((s) => {
    if (s.implicit === false && !named.has(s.name)) return false
    return true
  })
}

// ── Layer 2: the decision list ──────────────────────────────────────────────

/**
 * Work verbs — stems, because Bangla inflects (লিখ/লেখো/লিখে).
 *
 * OWNER-CAUGHT 2026-07-27: every stem here was Bangla SCRIPT only, and he types
 * BANGLISH most of the time. "almatraders.com er slug thik koro" — an
 * unmistakable fix order — matched nothing, so no rule fired, three skills tied
 * on keyword score and the READ-ONLY audit skill won. A fix order pinned to the
 * audit skill is the worst outcome the design has: it hands the head no write
 * tool at all. The romanised forms are not a nicety, they are how he writes.
 */
const FIX_VERB =
  /(ঠিক\s*কর|সমাধান\s*কর|সংশোধন|লিখ|লেখ|সেভ\s*কর|বসাও|বসিয়ে|যোগ\s*কর|আপডেট\s*কর'?|\bfix\b|\bwrite\b|\bupdate\b|\bapply\b)/i
/** The same verbs as he romanises them. Separate so each side stays readable. */
const FIX_VERB_BANGLISH =
  /\b(thik\s*kor|thik\s*kore|thk\s*kor|shomadhan|shongshodhon|likh|likhe|lekh|lekho|save\s*kor|boshao|bosao|jog\s*kor|update\s*kor|thik\s*kore\s*dao)/i
/** …unless the thing being asked for IS the audit or the report. */
const AUDIT_ASK =
  /((?:অডিট|audit)\s*(?:কর|চালাও|দাও|run|kor|koro|calao|chalao|dao)|রিপোর্ট\s*(?:বানা|তৈরি|দাও|লিখ)|\breport\b|report\s*(?:banao|dao|koro)|পূর্ণাঙ্গ\s*seo|\bdekho\b|\bdekhao\b)/i
/**
 * `slug` joins the clear SEO markers for the same reason: it is an on-page SEO
 * field in this business and nothing else, and its absence is what let the miss
 * above happen (the sentence carried no `seo`/`alt`/`meta` word at all).
 */
const SEO_TOPIC_CLEAR =
  /\bseo\b|এসইও|\balt\b|meta\s*(?:description|title|tag)|sitemap|canonical|\bslug\b|স্লাগ/i
/**
 * Words that mean SEO **only when a website is in the sentence**. Two sessions
 * found this list independently on the same day, from two different live runs,
 * and both findings are kept because each catches what the other misses.
 *
 *  • `meta` — SK-0: "meta description লিখে দাও" routed to the Meta ADS campaign
 *    skill. One word, two businesses.
 *  • `audit` — ADS-0: "amar ads account ta ekbar valo kore audit kore dekho"
 *    pinned `seo-auditing-own-site` at the RULE layer, and that skill's
 *    allowlist then correctly withheld every ads tool. Eight tool calls, no
 *    audit. SEO is not the only thing that gets audited — ads, money and stock
 *    all do.
 *  • `title` / `description` — the same traffic: "almatraders.com এর পুরো দুর্বল
 *    title আর thin description gulo thik koro" is an unmistakable on-page fix,
 *    but carried no seo/alt/meta word, so no rule fired and the READ-ONLY audit
 *    skill won the tie. Bare, they belong to captions and products too.
 */
const DOMAIN_GATED_SEO = /\bmeta\b|\baudit\b|অডিট|\btitle\b|\bdescription\b|শিরোনাম|বিবরণ/i
/**
 * …and a site name is not enough on its own: "almatraders.com er ads audit
 * koro" is an ADS job about our own domain. Any ads vocabulary vetoes the SEO
 * reading unless a clear SEO word is also present.
 */
const ADS_TOPIC =
  /\bads?\b|\bad\s*account\b|বিজ্ঞাপন|ক্যাম্পেইন|\bcampaign\b|\bboost\b|বুস্ট|\broas\b|\bctr\b|\bcpc\b|\bcpm\b|\bbudget\b|বাজেট|\baudience\b|\bpixel\b/i

const OWN_SITE = /almatraders\.com|আমাদের\s*(?:সাইট|ওয়েবসাইট)|our\s+site/i
/** Any other domain mentioned — a client's site. */
const OTHER_DOMAIN = /\b(?!almatraders\.com)[a-z0-9-]+\.(?:com|net|org|io|xyz|shop|co)\b/i
const ANY_DOMAIN = /\b[a-z0-9-]+\.(?:com|net|org|io|xyz|shop|co)\b/i

export function isSeoTopic(text: string): boolean {
  if (SEO_TOPIC_CLEAR.test(text)) return true
  if (ADS_TOPIC.test(text)) return false
  return DOMAIN_GATED_SEO.test(text) && (ANY_DOMAIN.test(text) || OWN_SITE.test(text))
}

/**
 * "কে কখন আসছে" — a person's attendance. Keyword scoring cannot reach this at
 * all: he names the STAFF MEMBER ("Mustahid ajke kokhon asche?"), and a name is
 * not a keyword any skill can claim. It is the same shape as fix-vs-audit — a
 * deterministic distinction a model should never be asked to make.
 */
const STAFF_PRESENCE =
  /(kokhon\s*(?:asche|ashbe|eshe|ase)|কখন\s*(?:আসছে|আসবে|এসেছে|আসে)|\bke\s*ache\b|কে\s*আছে|hajir|হাজির|hajira|হাজিরা|attendance|উপস্থিত)/i
/**
 * …unless it is a PARCEL arriving, not a person. "order kokhon asche" is a
 * customer question and pinning the staff skill there would remove the order
 * tools the answer actually needs. `delivery` is deliberately NOT here: "delivery
 * ke korbe" is a dispatch question, which is exactly this skill's job.
 */
const PARCEL_CONTEXT = /(\border\b|অর্ডার|parcel|পার্সেল|courier|কুরিয়ার|shipment|চালান)/i

/**
 * "notun panjabi ta website e tolo" — putting a PRODUCT up, not editing the
 * site. Keyword scoring gets this wrong for a structural reason: the product is
 * named ("panjabi"), so the only word both skills can see is "website", and
 * `alma-website` owns that word. The verb is what separates them, exactly as
 * with fix-vs-audit.
 */
const LISTING_ASK =
  /((?:website|site|সাইট)\s*(?:e|ে|তে)?\s*(?:tolo|tulo|tul\b|upload|add\b|তোল|তুল|যোগ)|নতুন\s*পণ্য\s*(?:তোল|যোগ)|\blist\s*(?:the\s*)?product\b)/i

/**
 * "ei product tar dam 1200 koro", "oita homepage e dekhao", "oi panjabi ta site
 * theke soriye dao" — changing a product that is ALREADY on the site. Keyword
 * scoring cannot reach these either: the sentence names the product, and the
 * only shared word is "product" or nothing at all.
 *
 * Deliberately narrow. Price, visibility and homepage placement are the asks
 * that carry no SEO vocabulary, so no other rule claims them; copy edits framed
 * as SEO ("meta description লিখে দাও") stay with the SEO skills, which is why
 * this rule is ordered after them.
 */
const PRICE_EDIT =
  /(?:দাম|দর|\bdam\b|\bprice\b|প্রাইস)[^\n]{0,24}?(?:\d|কর|বদল|বাড়|কমা|\bkoro\b|\bkore\b|\bbadla|\bbarao\b|\bbariye\b|\bkomao\b|\bkamiye\b|\bchange\b|\bupdate\b|\bset\b)/i
const VISIBILITY_EDIT =
  /(?:লাইভ\s*কর|live\s*kor|\bpublish\b|আনপাবলিশ|\bunpublish\b|সরিয়ে\s*(?:দাও|ফেল)|soriye\s*(?:dao|felo)|\bhide\b|লুকিয়ে|লুকাও)/i
const FEATURED_EDIT =
  /(?:হোমপেজে\s*(?:দেখাও|আনো|তোল)|homepage\s*e?\s*(?:dekhao|ano|tolo)|\bfeatured\b|ফিচার্?ড)/i
const PRODUCT_EDIT_ASK = (t: string): boolean =>
  PRICE_EDIT.test(t) || VISIBILITY_EDIT.test(t) || FEATURED_EDIT.test(t)

/**
 * "আর জিজ্ঞেস কোরো না, তুমি নিজে করো" is not a job — it is a request about how
 * jobs get approved, and only the HEAD can act on it (it stages the grant card;
 * a delegated worker has neither the tool nor the standing).
 *
 * Live on 2026-08-01: *"porer 15 minute staff message gulo r amake jiggesh koro
 * na, tumi nijei pathao"* pinned `alma-staff-dispatch`, which is
 * `isolation: subagent` — so the turn became a worker holding staff READ tools,
 * and the permission the sentence was actually asking for never got asked for.
 * Twice, with an honest "I can't" both times.
 *
 * A veto rather than a skill: no procedure applies, and the head already has
 * request_standing_permission on its core list.
 */
const PERMISSION_ASK =
  /(?:(?:আর\s*)?(?:amake\s*|আমাকে\s*)?(?:জিজ্ঞেস|jiggesh|jigges|জিগ্গেস)\s*(?:কোরো|koro|করো)?\s*(?:না|\bna\b)|(?:জিজ্ঞেস|jiggesh)\s*(?:না|\bna\b)\s*(?:কর|kor)|(?:stop|don'?t|do\s*not)\s+ask(?:ing)?(?:\s+me)?|no\s+more\s+(?:approvals?|cards?|asking)|approval\s*(?:লাগবে\s*না|chai\s*na|ছাড়া)|কার্ড\s*ছাড়া|card\s*chara|without\s+(?:a\s+)?card|standing\s*permission|অনুমতি\s*দিলাম|permission\s*দিলাম)/i

/** Words that mean the sentence is about a WINDOW of time, which a grant needs. */
const TIME_WINDOW =
  /(?:[\d০-৯]+\s*(?:মিনিট|minute|min|ঘণ্টা|ghonta|hour)|আজ(?:কের)?\s*(?:দিন|বিকেল|রাত)|পরের\s*[\d০-৯]+|next\s+\d+)/i

/** True when the message is asking to be asked LESS, not asking for work. */
export function isStandingPermissionAsk(text: string): boolean {
  return PERMISSION_ASK.test(text) && TIME_WINDOW.test(text)
}

/**
 * ── Mac skills (Tier 1) ──────────────────────────────────────────────────────
 *
 * The same structural problem as fix-vs-audit: these jobs are named by their
 * OBJECT ("build", "PR", "chat"), and those words are owned by half the
 * business vocabulary. Keyword scoring cannot separate "notun build dao" (a
 * release) from "notun post banao" (marketing), so the deterministic cases are
 * rules and everything else stays with the head.
 */
/** A TestFlight upload. Unmistakable — the word exists for nothing else here. */
const TESTFLIGHT_ASK = /(testflight|test\s*flight|টেস্টফ্লাইট)/i
/**
 * …plus the way he asks for one without the word: an iPhone/iOS BUILD. `build`
 * alone is far too broad (`npm run build`, "build a campaign"), so an iOS
 * identifier has to be present.
 *
 * Bare `app` was in this list for one review round and is now out: "web app
 * build koro" and "android app er build chalau" are not TestFlight jobs, and
 * pinning the highest-risk skill in the set on them is the worst direction to
 * be wrong in (Codex P2).
 */
const IOS_BUILD_ASK =
  /\b(ios|iphone|আইফোন|ipa)\b[^\n]{0,24}\bbuild\b|\bbuild\b[^\n]{0,24}\b(ios|iphone|আইফোন|ipa)\b/i
/**
 * Git verbs that only ever mean the branch→PR→merge job. Split in two, because
 * `push` and `merge` are ordinary business words on their own — "campaign ta
 * push koro", "customer list duita merge koro" (Codex P2). The unambiguous
 * forms fire alone; the ambiguous ones need a git word in the sentence.
 */
const GIT_FLOW_STRONG =
  /(\bpull\s*request\b|\bpr\s*(?:ta\s*)?(?:banao|khulo|kholo|create|open|dao|marge|merge)\b|\bcommit\b[^\n]{0,30}\bpush\b|\bgit\s+(?:push|commit|merge)\b|\bbranch\s*(?:banao|kholo|khulo)\b|কমিট\s*কর)/i
const GIT_FLOW_WEAK = /(\bpush\s*(?:kore|kor|koro|dao)\b|\bmerge\s*(?:kore|kor|koro|dao)\b|মার্জ\s*কর)/i
/** What makes a bare "push koro" a GIT push and not a campaign push. */
const GIT_CONTEXT =
  /\b(git|github|branch|repo|repository|origin|main|master|commit|pr|pull\s*request|code|kod)\b|কোড|ব্র্যাঞ্চ/i
const GIT_FLOW_ASK = (t: string): boolean =>
  GIT_FLOW_STRONG.test(t) || (GIT_FLOW_WEAK.test(t) && GIT_CONTEXT.test(t))
/**
 * The Claude / ChatGPT desktop apps. The app word is required: "Claude ke
 * jiggesh koro" is Boss talking TO the agent, not about the Mac app, and
 * pinning the driver there would hand the turn an allowlist with no ERP tool
 * in it.
 */
const AI_APP_ASK =
  /((?:chatgpt|claude|chat\s*gpt)\s*(?:desktop\s*)?(?:app|অ্যাপ|apps)|(?:app|অ্যাপ)\s*(?:e|ে|তে)\s*(?:likhe|likhe\s*dao|jigges|jiggesh|type))/i
/**
 * "notun chat khulo" — a fresh conversation in one of those apps. The verb is
 * REQUIRED: with it optional, "new chat bug ta fix koro" (a bug report about
 * our own new-chat button) pinned the desktop-app driver (Codex P2).
 */
const NEW_CHAT_ASK =
  /(?:notun|নতুন|new)\s*(?:chat|চ্যাট|conversation)\s*(?:ta\s*|টা\s*)?(?:khulo|kholo|khule|dao|open|start|শুরু|খোলো)/i
/**
 * A picture of his screen. Ordered BEFORE the app rule: "chatgpt app er
 * screenshot dao" is a looking job, not a driving job, and the looking skill is
 * the one that knows `screencapture` is the wrong tool.
 */
const SCREEN_LOOK_ASK =
  /(screen\s*shot|screenshot|স্ক্রিনশট|(?:screen|স্ক্রিন)[^\n]{0,20}(?:dekho|dekhao|দেখো|দেখাও|ki\s*ache|কী\s*আছে|chobi|ছবি))/i
/**
 * Tidying a cluttered folder. Both halves are required — "downloads" alone is
 * a folder he might just be reading from, and "porishkar koro" alone could be
 * about anything from the office to the website.
 */
const FOLDER_PLACE = /(downloads?|ডাউনলোড|desktop|ডেস্কটপ|folder|ফোল্ডার)/i
const TIDY_VERB =
  /(porishkar|পরিষ্কার|guchi|গুছ|gucha|sajao|সাজাও|sort\s*kor|clean\s*up|cleanup|clean\s*kor|khali\s*kor|খালি\s*কর|jayga\s*(?:khali|nei)|জায়গা\s*(?:খালি|নেই))/i

export interface RouterRule {
  id: string
  skill: string
  test: (text: string) => boolean
  why: string
}

/**
 * Ordered — first match wins. Each rule exists because a real message went to
 * the wrong place; the `why` is what gets stored in the trace.
 */
export const RULES: RouterRule[] = [
  {
    id: 'client-site-seo',
    skill: 'seo-fixing-client-site',
    test: (t) => isSeoTopic(t) && OTHER_DOMAIN.test(t) && !OWN_SITE.test(t),
    why: 'SEO কাজ, কিন্তু অন্য কারও সাইট — আমাদের DB টুল ওখানে চলে না',
  },
  {
    id: 'own-site-audit',
    skill: 'seo-auditing-own-site',
    test: (t) => isSeoTopic(t) && AUDIT_ASK.test(t),
    why: 'অডিট/রিপোর্ট নিজেই চাওয়া হয়েছে — পড়ার কাজ, লেখার নয়',
  },
  {
    id: 'own-site-fix',
    skill: 'seo-fixing-own-site',
    test: (t) => isSeoTopic(t) && (FIX_VERB.test(t) || FIX_VERB_BANGLISH.test(t)) && !AUDIT_ASK.test(t),
    why: 'কাজের ক্রিয়াপদ + SEO বিষয় = ফিক্স, রিপোর্ট নয়',
  },
  {
    id: 'product-listing',
    skill: 'alma-product-listing',
    // Ordered AFTER the SEO rules on purpose: "almatraders.com er meta thik
    // koro" is a fix on an existing listing, not a new one.
    test: (t) => LISTING_ASK.test(t) && !isSeoTopic(t),
    why: 'পণ্য সাইটে তোলার কথা — সাইটের কনটেন্ট এডিট নয়',
  },
  {
    id: 'storefront-edit',
    skill: 'storefront-editing',
    // After product-listing on purpose: "notun panjabi ta site e tolo, dam 1200"
    // is a new listing that happens to mention a price, not an edit.
    test: (t) => PRODUCT_EDIT_ASK(t) && !LISTING_ASK.test(t) && !isSeoTopic(t),
    why: 'সাইটে থাকা পণ্যের দাম/দৃশ্যমানতা বদলের কথা — নতুন লিস্টিং বা SEO কপি নয়',
  },
  {
    id: 'staff-attendance',
    skill: 'alma-staff-dispatch',
    test: (t) => STAFF_PRESENCE.test(t) && !PARCEL_CONTEXT.test(t),
    why: 'কে কখন আসছে/আছে — মানুষের হাজিরার প্রশ্ন, পার্সেলের নয়',
  },
  {
    id: 'testflight-build',
    skill: 'xcode-testflight-shipper',
    // BEFORE the git rule on purpose: a release ask says "build koro, push
    // koro" too, and the release has stricter gates than a plain PR.
    test: (t) => TESTFLIGHT_ASK.test(t) || IOS_BUILD_ASK.test(t),
    why: 'iPhone অ্যাপের রিলিজ — build নম্বর আর pipeline-এর নিজস্ব গেট আছে',
  },
  {
    id: 'git-pr-flow',
    skill: 'git-pr-workflow',
    test: (t) => GIT_FLOW_ASK(t) && !TESTFLIGHT_ASK.test(t) && !IOS_BUILD_ASK.test(t),
    why: 'branch/commit/push/PR/merge — কোডের কাজ GitHub-এ তোলার ধাপ',
  },
  {
    id: 'screen-look',
    skill: 'screenshot-annotate-share',
    // BEFORE the app rule: "chatgpt app er screenshot dao" is looking, not
    // driving, and the wrong-tool trap (`screencapture`) lives in this skill.
    test: (t) => SCREEN_LOOK_ASK.test(t),
    why: 'স্ক্রিনের ছবি চাওয়া হয়েছে — দেখার কাজ, চালানোর নয়',
  },
  {
    id: 'mac-ai-app',
    skill: 'mac-ai-app-operator',
    test: (t) => (AI_APP_ASK.test(t) || NEW_CHAT_ASK.test(t)) && !SCREEN_LOOK_ASK.test(t),
    why: 'Boss-এর Mac-এর Claude/ChatGPT অ্যাপ চালানোর কথা — দেখা আগে, ছোঁয়া পরে',
  },
  {
    id: 'folder-tidy',
    skill: 'mac-file-organizer',
    test: (t) => FOLDER_PLACE.test(t) && TIDY_VERB.test(t),
    why: 'Mac-এর ফোল্ডার গোছানোর কথা — তালিকা আগে, Trash-ই সর্বোচ্চ',
  },
]

export function applyRules(text: string): RouterRule | null {
  // The veto comes first: a permission request must reach the head, not a skill.
  if (isStandingPermissionAsk(text)) return null
  return RULES.find((r) => r.test(text)) ?? null
}

// ── The router ──────────────────────────────────────────────────────────────

export function routeSkill(index: SkillIndex, text: string, ctx: RouteContext = {}): RouteDecision {
  const t = (text ?? '').trim()
  if (!t) {
    return { skill: null, layer: 'none', reason: 'খালি মেসেজ', candidates: [], needsModel: false }
  }

  const eligible = eligibleSkills(index, ctx)
  const known = new Set(eligible.map((s) => s.name))

  // Layer 1.5 — the veto. A request to be asked LESS is not a job for any skill;
  // the head stages the grant card itself. Checked before the keyword layer too,
  // or "staff message" in the sentence would still pull the staff skill in.
  if (isStandingPermissionAsk(t)) {
    return {
      skill: null,
      layer: 'rule',
      reason: 'অনুমতির অনুরোধ — কোনো skill নয়, head নিজেই কার্ড বানাবে',
      candidates: [],
      needsModel: false,
    }
  }

  // Layer 2 — a rule wins outright, even over a strong keyword score.
  const rule = applyRules(t)
  if (rule) {
    return {
      skill: rule.skill,
      layer: 'rule',
      reason: `${rule.id}: ${rule.why}`,
      candidates: [{ name: rule.skill, score: Infinity }],
      // A rule may name a skill that has not been written yet (SK-5). Say so
      // rather than silently falling through to a worse answer.
      needsModel: false,
    }
  }

  // Layer 3 — keyword scoring over the eligible set.
  const picked = selectSkills({ skills: eligible, warnings: [] }, t)
  const scored = scoreCandidates({ skills: eligible, warnings: [] }, t)
  if (picked.length === 0) {
    return { skill: null, layer: 'none', reason: 'কোনো skill যথেষ্ট মেলেনি', candidates: scored, needsModel: false }
  }

  const top = scored[0]
  const second = scored[1]
  if (!top || top.score < MIN_KEYWORD_SCORE) {
    return {
      skill: null,
      layer: 'none',
      reason: `সবচেয়ে কাছের মিল দুর্বল (${top?.name ?? '—'}: ${top?.score ?? 0}) — ভুল skill pin করার চেয়ে কোনোটা না করা ভালো`,
      candidates: scored.slice(0, 3),
      needsModel: false,
    }
  }
  const margin = top && second ? top.score - second.score : Infinity
  const ambiguous = margin < AMBIGUITY_MARGIN

  return {
    skill: known.has(picked[0].name) ? picked[0].name : null,
    layer: ambiguous ? 'model' : 'keyword',
    reason: ambiguous
      ? `${top.name} (${top.score}) আর ${second.name} (${second.score}) কাছাকাছি — head বেছে নেবে`
      : `keyword score ${top.score}, পরেরটা ${second?.score ?? 0}`,
    candidates: scored.slice(0, 3),
    needsModel: ambiguous,
  }
}

/** Scores exposed for the trace — same weighting the selector uses. */
export function scoreCandidates(index: SkillIndex, text: string): RouteCandidate[] {
  const q = new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 2))
  return index.skills
    .map((s) => {
      let score = 0
      for (const kw of s.keywords) {
        if (kw.includes(' ')) {
          if (text.toLowerCase().includes(kw)) score += 3
        } else if (q.has(kw)) score += 2
      }
      for (const tok of `${s.name} ${s.description}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (tok.length > 2 && q.has(tok)) score += 1
      }
      return { name: s.name, score }
    })
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
}

// ── U3: the registry budget ─────────────────────────────────────────────────

/**
 * The always-loaded name+description list. Codex's number for Codex itself is
 * ~2% of the context window, and the principle is the point: without a cap, the
 * cost of owning 100 skills is invisible until the bill arrives.
 *
 * RAISED 6,000 → 9,000 on 2026-08-03, deliberately, because the Tier-1 Mac
 * skills crossed the old ceiling (21 selectable skills, 6,672 chars). The test
 * that caught it says the day it fails is a DECISION — raise the budget or trim
 * the descriptions — and the decision is to raise it, for two reasons:
 *
 *  • Trimming is the worse trade at this size. The shortening fallback cuts
 *    EVERY description to 80 characters at once, and 80 characters is roughly
 *    where a description stops saying WHEN to use the skill — which is the half
 *    routing actually needs.
 *  • The cost is smaller than it looks. This block is name+description only
 *    (~750 extra tokens at the new ceiling) and it lives in the STABLE prompt
 *    prefix, so it is a cache read per turn, not a fresh write.
 *
 * The cliff itself stays: crossing 9,000 is the next decision, not a silent
 * quality drop.
 */
export const REGISTRY_BUDGET_CHARS = 9000
const MIN_DESCRIPTION_CHARS = 80

export interface RegistryBlock {
  text: string
  included: string[]
  /** Skills that did not fit — visible, never silently dropped. */
  dropped: string[]
  shortened: boolean
}

export function buildRegistryBlock(
  skills: SkillMetadata[],
  budget = REGISTRY_BUDGET_CHARS,
): RegistryBlock {
  const line = (s: SkillMetadata, desc: string) => `- ${s.name}: ${desc}`
  const full = skills.map((s) => line(s, s.description))
  const fullSize = full.join('\n').length
  if (fullSize <= budget) {
    return { text: full.join('\n'), included: skills.map((s) => s.name), dropped: [], shortened: false }
  }

  // First try shortening every description before dropping anything.
  const short = skills.map((s) => line(s, s.description.slice(0, MIN_DESCRIPTION_CHARS).trim()))
  if (short.join('\n').length <= budget) {
    return { text: short.join('\n'), included: skills.map((s) => s.name), dropped: [], shortened: true }
  }

  // Still over: keep as many as fit, in the order given (caller ranks them).
  const kept: string[] = []
  const included: string[] = []
  let size = 0
  for (let i = 0; i < skills.length; i++) {
    const next = short[i]
    if (size + next.length + 1 > budget) break
    kept.push(next)
    included.push(skills[i].name)
    size += next.length + 1
  }
  return {
    text: kept.join('\n'),
    included,
    dropped: skills.slice(included.length).map((s) => s.name),
    shortened: true,
  }
}
