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

export function eligibleSkills(
  index: SkillIndex,
  ctx: RouteContext = {},
  text?: string,
): SkillMetadata[] {
  const named = new Set(ctx.namedByOwner ?? [])
  // An image he ALREADY HAS is never a reason to photograph his desktop — at
  // any layer. Without this the keyword layer re-pinned what the rule refused.
  const vetoScreenSkill = Boolean(text && EXISTING_IMAGE_REF.test(text))
  return index.skills.filter((s) => {
    if (s.implicit === false && !named.has(s.name)) return false
    if (vetoScreenSkill && s.name === SCREEN_SKILL) return false
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
  /((?:অডিট|audit)\s*(?:কর|চালাও|দাও|run|kor|koro|calao|chalao|dao)|\baudit\b(?!\s+(?:finding|findings|issue|issues|problem|problems)\b)|রিপোর্ট\s*(?:বানা|তৈরি|দাও|লিখ)|\breport\b|report\s*(?:banao|dao|koro)|পূর্ণাঙ্গ\s*seo|\bdekho\b|\bdekhao\b)/i
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
const AI_APP_NAME =
  /((?:chatgpt|claude|chat\s*gpt)\s*(?:desktop\s*)?(?:app|অ্যাপ|apps)|(?:app|অ্যাপ)\s*(?:e|ে|তে)\s*(?:likhe|likhe\s*dao|jigges|jiggesh|type))/i
/**
 * Naming the app is not asking for it to be DRIVEN. "ChatGPT app integration
 * bug ta fix koro" is a coding request about our own product, and pinning the
 * isolated operator there hands the turn a skill that explicitly refuses coding
 * work — the request then has nowhere to go (Codex).
 */
const AI_APP_OPERATION =
  /(khulo|kholo|khule|likhe|likho|lekho|jigges|jiggesh|type|pathao|dekho|dekhao|chalao|bolo|\bask\b|\bopen\b|\bsend\b|খোলো|লিখে|লেখো|জিজ্ঞেস|দেখো|দেখাও|পাঠাও)/i
/** …and any of these means it is a job about the software, not on the desktop. */
const SOFTWARE_WORK_REF =
  /(\bbug\b|বাগ|\bfix\b|integration|\bfeature\b|\bcode\b|কোড|\berror\b|crash|deploy|\bapi\b|\bui\b)/i
const AI_APP_ASK = (t: string): boolean =>
  AI_APP_NAME.test(t) && AI_APP_OPERATION.test(t) && !SOFTWARE_WORK_REF.test(t)
/**
 * "notun chat khulo" — a fresh conversation in one of those apps. The verb is
 * REQUIRED: with it optional, "new chat bug ta fix koro" (a bug report about
 * our own new-chat button) pinned the desktop-app driver (Codex P2).
 */
const NEW_CHAT_ASK =
  /(?:notun|নতুন|new)\s*(?:chat|চ্যাট|conversation)\s*(?:ta\s*|টা\s*)?(?:khulo|kholo|khule|dao|open|start|শুরু|খোলো)/i
/**
 * A picture of HIS MAC SCREEN, right now. Ordered BEFORE the app rule:
 * "chatgpt app er screenshot dao" is a looking job, not a driving job, and the
 * looking skill is the one that knows `screencapture` is the wrong tool.
 *
 * Narrowed after review (Codex P1): the word "screenshot" alone also appears
 * when Boss is talking about an image he ALREADY HAS — "ei screenshot ta dekhe
 * invoice enter koro". Pinning that to the Mac-only skill is doubly wrong: its
 * allowlist holds no invoice or image tool, and its procedure would capture his
 * unrelated desktop. So a capture VERB is required, and a reference to an
 * existing image vetoes the rule outright.
 */
const SCREEN_CAPTURE_ASK =
  /((?:screen\s*shot|screenshot|স্ক্রিনশট)\s*(?:ta\s*|টা\s*|ekta\s*|একটা\s*)?(?:dao|de\b|nao|nio|tulo|tolo|tule|dekhao|pathao|niye\s*asho|দাও|নাও|তোলো|তুলে|দেখাও|পাঠাও)|(?:ekta\s*|একটা\s*|amar\s*|আমার\s*)?(?:screen\s*shot|screenshot|স্ক্রিনশট)\s*(?:lagbe|চাই|লাগবে)|(?:screen|স্ক্রিন)[^\n]{0,20}(?:dekho|dekhao|দেখো|দেখাও|ki\s*ache|কী\s*আছে|chobi|ছবি))/i
/** An image he already has — not a request to capture his desktop. */
const EXISTING_IMAGE_REF =
  /((?:এই|ei|oi|ওই|উপরের|uporer|attached|uploaded|pathano|পাঠানো)\s*(?:screen\s*shot|screenshot|স্ক্রিনশট|ছবি|chobi|image))/i
const SCREEN_LOOK_ASK = (t: string): boolean =>
  SCREEN_CAPTURE_ASK.test(t) && !EXISTING_IMAGE_REF.test(t)
/**
 * The skill the veto has to keep out, by name — because vetoing it in the RULE
 * layer is only half the job. "ei screenshot ta dekho" falls through to keyword
 * scoring, where the literal word `screenshot` is worth 2 and the skill-name
 * token another 1: enough to pin the Mac-only skill anyway, and capture his
 * desktop for a question about an image he already has (Codex round 3, on a
 * test of mine that only ever exercised `applyRules`).
 */
const SCREEN_SKILL = 'screenshot-annotate-share'
/**
 * Tidying a cluttered folder. Both halves are required — "downloads" alone is
 * a folder he might just be reading from, and "porishkar koro" alone could be
 * about anything from the office to the website.
 */
const FOLDER_PLACE = /(downloads?|ডাউনলোড|desktop|ডেস্কটপ|folder|ফোল্ডার)/i
/**
 * The sentence is about FILES ON HIS MAC, not about a product on the website.
 *
 * Live 2026-08-03: *"downloads er sob pdf ekta Reports folder e soriye dao"*
 * pinned `storefront-editing` — its visibility rule owns "soriye dao", which in
 * that skill means unpublishing a product. The pin then handed the turn a
 * storefront allowlist with no Mac tool in it, and the head reported an approval
 * card that could never have existed. Same shape as every other rule here: one
 * phrase, two jobs, and only the surrounding words can tell them apart.
 */
const MAC_FILESYSTEM_CONTEXT =
  /(downloads?|ডাউনলোড|desktop|ডেস্কটপ|folder|ফোল্ডার|\.(?:pdf|dmg|zip|png|jpe?g|mp4|csv)\b|\bfiles?\b|ফাইল|\bmac\b|ম্যাক)/i
/**
 * …and a CODE checkout is not this skill's folder (Codex P2). "alma-erp folder
 * clean up koro" matched both halves, and the pin would then hand the turn the
 * organizer's tools and its own refusal — so the request could reach neither
 * this skill nor the git flow that should handle it.
 */
const CODE_CHECKOUT =
  /(alma-erp|alma-companion|\brepo\b|repository|\bgit\b|node_modules|checkout|codebase|\bcode\s*(?:folder|base)\b|কোডের\s*ফোল্ডার)/i
const TIDY_VERB =
  /(porishkar|পরিষ্কার|guchi|গুছ|gucha|sajao|সাজাও|sort\s*kor|clean\s*up|cleanup|clean\s*kor|khali\s*kor|খালি\s*কর|jayga\s*(?:khali|nei)|জায়গা\s*(?:খালি|নেই)|soriye\s*(?:dao|rakho|felo|rekho)|সরিয়ে\s*(?:দাও|রাখো|রেখো)|\bsorao\b|\bmove\s*kor)/i

/**
 * ── Mac skills (Tier 2) ──────────────────────────────────────────────────────
 */
/** "mac ta slow", "jayga nei" — a question about the machine's own health. */
const MAC_HEALTH_ASK =
  /((?:mac|ম্যাক|laptop|ল্যাপটপ)[^\n]{0,24}(?:slow|স্লো|dhire|obostha|অবস্থা|health|garam|hang|atke)|(?:disk|ডিস্ক|storage|স্টোরেজ|memory|ram|battery|ব্যাটারি)[^\n]{0,20}(?:full|ভরে|nei|নেই|koto|কত|obostha|check|dekho|দেখো)|jayga\s*(?:nei|ses|kome)|জায়গা\s*(?:নেই|শেষ))/i
/**
 * Looking for a FILE he cannot place. The verb has to be a search verb and the
 * object has to be a file — "khujo" alone is how he asks for research, and
 * `alma-research` owns that.
 */
const FILE_SEARCH_ASK =
  /((?:file|ফাইল|pdf|invoice|ইনভয়েস|document|ডকুমেন্ট|chobi|ছবি|screenshot|folder)[^\n]{0,30}(?:khujo|khuje|খুঁজ|kothay|কোথায়|pacchi\s*na|পাচ্ছি\s*না|find|search)|(?:khujo|khuje\s*dao|খুঁজে\s*দাও)[^\n]{0,20}(?:file|ফাইল|pdf|document|ডকুমেন্ট))/i
/** …but a search of the WEB or the business data is not a Spotlight job. */
const NOT_LOCAL_SEARCH =
  /(google|web\s*e|internet|online|competitor|প্রতিযোগী|website|ওয়েবসাইট|erp\b|order|অর্ডার|customer|কাস্টমার)/i
/** Shrinking / converting media that already exists on the Mac. */
const MEDIA_CONVERT_ASK =
  /((?:video|ভিডিও|clip|ছবি|chhobi|chobi|image|photo|ফটো|gif|audio|অডিও|mp4|mov|png|jpe?g)[^\n]{0,30}(?:compress|choto\s*kor|ছোট\s*কর|resize|convert|bodla|বদলা|trim|kato|কাটো|ber\s*kor|বের\s*কর)|(?:compress|choto\s*kor|ছোট\s*কর)[^\n]{0,20}(?:video|ভিডিও|ছবি|chobi|image|file|ফাইল))/i
/** …but MAKING new media is Creative Studio's job, not a converter's. */
const MEDIA_CREATE_ASK =
  /(banao|বানাও|toiri|তৈরি|generate|design|ডিজাইন|poster|পোস্টার|creative|ad\s*banao)/i

/**
 * A fresh creative image request.  This must be deterministic: falling through
 * to token scoring lets the common words "ALMA" and "agent" select the
 * incident-diagnosis skill, whose read-only allowlist then removes
 * `generate_image` from the turn.
 *
 * Keep both halves mandatory.  Merely mentioning an image (for example,
 * "inspect this image") is not generation, and a generic "create a report"
 * is not an image job.
 */
const IMAGE_OUTPUT =
  /(?:image|images|photo|photos|picture|pictures|poster|posters|illustration|illustrations|artwork|creative|visual\s+variation|visual\s+variations|ছবি|ফটো|পোস্টার|ইমেজ|ক্রিয়েটিভ|ভিজুয়াল)/i
const IMAGE_GENERATION_VERB =
  /(?:create|generate|make|design|render|produce|বানাও|বানিয়ে|তৈরি|ডিজাইন|জেনারেট|রেন্ডার)/i
const NON_IMAGE_CREATION_OBJECT =
  /\b(?:report|comparison|compare|comparing|analysis|audit|summary|article|document|guide|list|research|presentation|spreadsheet|code|model|models)\b|(?:রিপোর্ট|তুলনা|বিশ্লেষণ|অডিট|সারাংশ|নথি|তালিকা|গবেষণা)/i
const NON_IMAGE_OUTPUT_SUFFIX =
  /^\s*(?:(?:classification|recognition|generation|diffusion|vision|machine[- ]learning|ml|ai)\s+){0,4}(?:model|system|api|code|library|framework|classifier)\b|^\s*(?:ক্লাসিফিকেশন|মডেল|সিস্টেম|কোড|লাইব্রেরি)\b/i

function matchRanges(pattern: RegExp, text: string): Array<{ start: number; end: number }> {
  const matches: Array<{ start: number; end: number }> = []
  const regex = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`)
  for (const match of text.matchAll(regex)) {
    if (match.index === undefined) continue
    matches.push({ start: match.index, end: match.index + match[0].length })
  }
  return matches
}

/** VIDEO/reel creation — routes to alma-media-video, never the image pipeline. */
const VIDEO_OUTPUT = /(?:videos?|ভিডিও|reels?|রিল|রীল)/i
/** "video cards"/"video player" are UI artifacts in an answer, not video-making. */
const NON_VIDEO_OUTPUT_SUFFIX = /^\s*(?:cards?|players?|tags?|elements?|embeds?)\b/i

export const isVideoCreationAsk = (text: string): boolean => {
  if (MEDIA_DERIVE_ASK.test(text)) return false
  // Same proximity discipline as the image detector: a creation verb must sit
  // near the video noun in the same sentence, and formatting-only answer asks
  // ("rendered LaTeX … video cards") belong to the unrestricted head.
  if (ANSWER_FORMAT.test(text) && ANSWER_VERB.test(text)) return false
  const outputs = matchRanges(VIDEO_OUTPUT, text)
  const verbs = matchRanges(IMAGE_GENERATION_VERB, text)
  return verbs.some((verb) => outputs.some((output) => {
    const distance = Math.max(verb.start, output.start) - Math.min(verb.end, output.end)
    if (distance > 160) return false
    const between = verb.end <= output.start
      ? text.slice(verb.end, output.start)
      : text.slice(output.end, verb.start)
    if (/[.!?\n]/.test(between)) return false
    return !NON_VIDEO_OUTPUT_SUFFIX.test(text.slice(output.end, output.end + 40))
  }))
}

export const isImageGenerationAsk = (text: string): boolean => {
  if (MEDIA_DERIVE_ASK.test(text)) return false
  // "chobi diye VIDEO banao" is a video ask that happens to mention images —
  // the video pipeline owns it (hit live: the image rule pinned it and its
  // allowlist starved plan_media_video).
  if (isVideoCreationAsk(text)) return false
  const outputs = matchRanges(IMAGE_OUTPUT, text)
  const verbs = matchRanges(IMAGE_GENERATION_VERB, text)

  return verbs.some((verb) => outputs.some((output) => {
    const distance = Math.max(verb.start, output.start) - Math.min(verb.end, output.end)
    if (distance > 160) return false
    const between = verb.end <= output.start
      ? text.slice(verb.end, output.start)
      : text.slice(output.end, verb.start)
    if (/[.!?\n]/.test(between)) return false
    if (NON_IMAGE_CREATION_OBJECT.test(between)) return false
    const outputSuffix = text.slice(output.end, output.end + 100)
    return !NON_IMAGE_OUTPUT_SUFFIX.test(outputSuffix)
  }))
}

/** Research/citation asks should use the existing cited-research procedure. */
const CITED_RESEARCH_ASK =
  /(?:official\s+(?:source|sources|documentation)|inline\s+citation|citations?|sources?\s+list|উৎস|সাইটেশন|সূত্র)/i

/** Pure answer-format requests need the normal head, not a narrow workflow. */
const ANSWER_FORMAT =
  /(?:rich\s+response|syntax[- ]highlighted|code\s+block|rendered\s+latex|mermaid|interactive\s+form|exactly\s+(?:[\d০-৯]+|one|two|three|four|five|six|seven|eight|nine|ten)\s+numbered|ঠিক\s+[\d০-৯]+টি\s+numbered|numbered\s+steps?|bullet\s+list)/i
const ANSWER_VERB = /(?:write|return|give|provide|show|list|লিখ|দাও|দেখাও|তৈরি\s+কর)/i
const FORMAT_ONLY_NEGATION =
  /(?:do\s+not|don't|never|কোরো\s+না|করবে\s+না)[^.!?\n]{0,120}(?:create|save|publish|execute|run|send|post|ask)|(?:just|only)\s+(?:return|write|show|list)/i
export const isHeadOnlyAnswerAsk = (text: string): boolean =>
  ANSWER_FORMAT.test(text) && ANSWER_VERB.test(text) && !isImageGenerationAsk(text)
/**
 * …unless the sentence names a SOURCE and a TARGET: "video theke gif banao" is
 * a conversion wearing the word "banao" (Codex). Source-to-target beats the
 * creation veto, because nothing is being invented — an existing file is.
 */
const MEDIA_DERIVE_ASK =
  /(?:video|ভিডিও|mp4|mov|clip|chobi|ছবি|image|png|jpe?g|audio|অডিও)\s*(?:theke|থেকে|from|to\b|→)\s*(?:gif|jpe?g|png|mp3|mp4|wav|audio|অডিও|ছবি|chobi|video|ভিডিও)/i

/** PDF work on files he already has. */
const PDF_ASK =
  /\bpdf\b[^\n]{0,30}(?:merge|jora|jode|ek\s*kor|vag|bhag|split|choto|compress|page|pata|porho|poro|lekha|text)|(?:merge|jora|ek\s*kor|split|vag)[^\n]{0,20}\bpdf\b/i
/** …but producing a report/invoice PDF from OUR data is the report tools' job. */
const PDF_GENERATE_ASK =
  /(report\s*banao|invoice\s*banao|রিপোর্ট\s*বানাও|generate|toiri\s*koro|client\s*report[^\n]{0,20}(?:banao|toiri|generate|বানাও))/i
/** "kajer mode chalu koro" — open the usual set of apps. */
const WORKSPACE_ASK =
  /((?:kaj|কাজ|hisab|হিসাব|code|কোড|office|অফিস)[^\n]{0,10}(?:er)?\s*(?:mode|মোড)|(?:mode|মোড)\s*(?:chalu|চালু|on\s*kor)|(?:amar|আমার)\s*(?:sob|সব|roj|রোজ)[^\n]{0,14}(?:app|অ্যাপ)[^\n]{0,12}(?:kholo|খোলো|chalu|open))/i

/**
 * ── Mac skills (Tier 3) ──────────────────────────────────────────────────────
 */
/** A Claude/Codex CLI session on his Mac — not the desktop app, not one command. */
const CLI_SESSION_ASK =
  /((?:claude|codex)\s*(?:cli\s*)?(?:session|সেশন)|(?:session|সেশন)\s*(?:ta\s*)?(?:kholo|khulo|khule|chalao|start|open|শুরু|খোলো)|(?:mac|ম্যাক)[^\n]{0,20}(?:session|সেশন))/i
/** Running the app in the Simulator to LOOK at it. */
const SIMULATOR_ASK =
  /(simulator|সিমুলেটর|simulater|(?:build\s*kore|বিল্ড\s*করে)\s*(?:dekho|দেখো)|(?:app|অ্যাপ)[^\n]{0,20}(?:screen|স্ক্রিন)[^\n]{0,16}(?:thik|ঠিক|dekho|দেখো))/i
/** Is this Mac backed up at all. */
const BACKUP_WORD =
  /(backup|ব্যাকআপ|back\s*up|time\s*machine|টাইম\s*মেশিন|(?:file|ফাইল|data|ডেটা)[^\n]{0,20}(?:safe|নিরাপদ|hariye|হারিয়ে))/i
/**
 * …but "backup" is also the PRODUCTION database and the website (this repo has
 * `scripts/backup-production.mjs`). Those are server-side and have nothing to do
 * with his laptop — pinning the Mac skill there sends a worker to check Time
 * Machine when he asked about the ERP (Codex).
 */
const SERVER_BACKUP_REF =
  /(database|ডাটাবেস|\bdb\b|erp\b|server|সার্ভার|production|prod\b|website|ওয়েবসাইট|supabase|vercel|vps)/i
const BACKUP_ASK = (t: string): boolean => BACKUP_WORD.test(t) && !SERVER_BACKUP_REF.test(t)

/** Safety settings on the machine — not backups, not disk space. */
const MAC_SECURITY_WORD =
  /(filevault|firewall|ফায়ারওয়াল|encrypt|এনক্রিপ|(?:mac|ম্যাক)[^\n]{0,20}(?:secure|নিরাপদ|security|নিরাপত্তা)|(?:update|আপডেট)[^\n]{0,16}(?:baki|বাকি|pending|ache\s*kina))/i
/**
 * …but "update baki ache kina" is just as likely to be about the WEBSITE or the
 * ERP, and pinning the Mac skill there narrows the turn to Mac tools and leaves
 * the real question unanswerable (Codex).
 */
const NON_MAC_CONTEXT =
  /(website|ওয়েবসাইট|erp\b|server|সার্ভার|production|prod\b|vercel|supabase|vps|app\s*store|android)/i
const MAC_SECURITY_ASK = (t: string): boolean =>
  MAC_SECURITY_WORD.test(t) && !NON_MAC_CONTEXT.test(t)
/** His day — the Mac's calendar/reminders lined up with the ERP's. */
const CALENDAR_ASK =
  /((?:calendar|ক্যালেন্ডার|reminder|রিমাইন্ডার)[^\n]{0,24}(?:dekh|দেখ|ki\s*ache|কী\s*আছে|ache\s*kina)|(?:ajke|আজকে|ajker|আজকের)[^\n]{0,20}(?:calendar|ক্যালেন্ডার|meeting|মিটিং|appointment)|(?:ki|কী)\s*(?:ache|আছে)[^\n]{0,14}(?:calendar|ক্যালেন্ডারে))/i

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
    // BEFORE image-generation: "ছবি দিয়ে ভিডিও বানাও" contains both an image
    // noun and a creation verb — the video pipeline must win deterministically.
    id: 'media-video',
    skill: 'alma-media-video',
    test: (t) => isVideoCreationAsk(t),
    why: 'ভিডিও/রিল বানাতে বলা হয়েছে — media-video plan pipeline (plan card → approve → auto render)',
  },
  {
    id: 'image-generation',
    skill: 'alma-image-generation',
    test: (t) => isImageGenerationAsk(t),
    why: 'নতুন ছবি/পোস্টার/variation বানাতে বলা হয়েছে — existing generate_image approval pipeline ব্যবহার হবে',
  },
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
    test: (t) =>
      PRODUCT_EDIT_ASK(t)
      && !LISTING_ASK.test(t)
      && !isSeoTopic(t)
      // …and it is not his Mac's files. "soriye dao" belongs to both jobs.
      && !MAC_FILESYSTEM_CONTEXT.test(t),
    why: 'সাইটে থাকা পণ্যের দাম/দৃশ্যমানতা বদলের কথা — নতুন লিস্টিং বা SEO কপি নয়',
  },
  {
    id: 'staff-attendance',
    skill: 'alma-staff-dispatch',
    test: (t) => STAFF_PRESENCE.test(t) && !PARCEL_CONTEXT.test(t),
    why: 'কে কখন আসছে/আছে — মানুষের হাজিরার প্রশ্ন, পার্সেলের নয়',
  },
  {
    id: 'simulator-check',
    skill: 'ios-simulator-verifier',
    // BEFORE the release rule: "ios build kore dekho" is looking at the app,
    // not shipping it, and the release rule owns the word "build".
    test: (t) => SIMULATOR_ASK.test(t) && !TESTFLIGHT_ASK.test(t),
    why: 'Simulator-এ চালিয়ে দেখা — TestFlight-এ পাঠানো নয়',
  },
  {
    id: 'testflight-build',
    skill: 'xcode-testflight-shipper',
    // BEFORE the git rule on purpose: a release ask says "build koro, push
    // koro" too, and the release has stricter gates than a plain PR.
    test: (t) => TESTFLIGHT_ASK.test(t) || (IOS_BUILD_ASK.test(t) && !SIMULATOR_ASK.test(t)),
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
    test: (t) => SCREEN_LOOK_ASK(t),
    why: 'স্ক্রিনের ছবি চাওয়া হয়েছে — দেখার কাজ, চালানোর নয়',
  },
  {
    id: 'mac-ai-app',
    skill: 'mac-ai-app-operator',
    test: (t) => (AI_APP_ASK(t) || NEW_CHAT_ASK.test(t)) && !SCREEN_LOOK_ASK(t),
    why: 'Boss-এর Mac-এর Claude/ChatGPT অ্যাপ চালানোর কথা — দেখা আগে, ছোঁয়া পরে',
  },
  {
    id: 'cli-session',
    skill: 'mac-cli-session-runner',
    // Before the app rule: "claude session kholo" is the CLI, not the GUI app.
    test: (t) => CLI_SESSION_ASK.test(t),
    why: 'Mac-এ Claude/Codex সেশন চালানোর কথা — অ্যাপ নয়, CLI',
  },
  {
    id: 'mac-security',
    skill: 'mac-security-check',
    test: (t) => MAC_SECURITY_ASK(t),
    why: 'Mac-এর নিরাপত্তা-সেটিং — শুধু পড়া, বদলানো নয়',
  },
  {
    id: 'calendar-day',
    skill: 'calendar-reminders-bridge',
    test: (t) => CALENDAR_ASK.test(t),
    why: 'Mac-এর ক্যালেন্ডার + ERP মিলিয়ে আজকের তালিকা',
  },
  {
    id: 'backup-check',
    skill: 'mac-backup-verifier',
    test: (t) => BACKUP_ASK(t),
    why: 'ব্যাকআপ আছে কিনা — শুধু পড়ার কাজ',
  },
  {
    id: 'mac-health',
    skill: 'mac-health-monitor',
    test: (t) => MAC_HEALTH_ASK.test(t),
    why: 'Mac-এর নিজের অবস্থার প্রশ্ন — শুধু পড়া, কিছু বদলানো নয়',
  },
  {
    id: 'file-search',
    skill: 'spotlight-finder',
    test: (t) => FILE_SEARCH_ASK.test(t) && !NOT_LOCAL_SEARCH.test(t),
    why: 'Mac-এ পড়ে থাকা ফাইল খোঁজা — ওয়েব বা ERP-র খোঁজ নয়',
  },
  {
    id: 'media-convert',
    skill: 'media-transcoder',
    // Ordered before folder-tidy: "video gulo choto koro" is a conversion, and
    // the tidy rule would otherwise claim any sentence with a folder in it.
    test: (t) =>
      MEDIA_DERIVE_ASK.test(t)
      || (MEDIA_CONVERT_ASK.test(t) && !MEDIA_CREATE_ASK.test(t)),
    why: 'Mac-এ থাকা মিডিয়া রূপান্তর — নতুন কিছু বানানো নয়',
  },
  {
    id: 'pdf-work',
    skill: 'pdf-processor',
    test: (t) => PDF_ASK.test(t) && !PDF_GENERATE_ASK.test(t),
    why: 'Mac-এ থাকা PDF নিয়ে কাজ — নতুন রিপোর্ট বানানো নয়',
  },
  {
    id: 'workspace-open',
    skill: 'workspace-launcher',
    test: (t) => WORKSPACE_ASK.test(t),
    why: 'নাম-করা অ্যাপ-সেট একসাথে খোলা',
  },
  {
    id: 'folder-tidy',
    skill: 'mac-file-organizer',
    test: (t) => FOLDER_PLACE.test(t) && TIDY_VERB.test(t) && !CODE_CHECKOUT.test(t),
    why: 'Mac-এর ফোল্ডার গোছানোর কথা — তালিকা আগে, Trash-ই সর্বোচ্চ',
  },
  {
    // Citation formatting cannot replace a concrete execution workflow. Keep
    // this broad research fallback last so "audit SEO with official sources"
    // still runs the audit skill, while a standalone comparison gets research.
    id: 'cited-research',
    skill: 'alma-research',
    test: (t) => CITED_RESEARCH_ASK.test(t),
    why: 'official source ও inline citation চাওয়া হয়েছে — cited research procedure দরকার',
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

  const eligible = eligibleSkills(index, ctx, t)
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

  // Explicitly negated execution is an answer request, not a workflow. Check
  // this before deterministic rules so words inside "do not create/publish"
  // cannot stage a storefront or campaign action.
  if (isHeadOnlyAnswerAsk(t) && FORMAT_ONLY_NEGATION.test(t)) {
    return {
      skill: null,
      layer: 'rule',
      reason: 'answer-format: execution explicitly forbidden — unrestricted head শুধু requested answer দেবে',
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

  // Score before the format fallback. A clearly dominant keyword workflow is
  // still a workflow when the owner asks for bullets; an ambiguous pile of
  // format words (code/LaTeX/Mermaid, or a plain numbered answer) belongs to
  // the unrestricted head rather than whichever narrow skill barely wins.
  const picked = selectSkills({ skills: eligible, warnings: [] }, t)
  const scored = scoreCandidates({ skills: eligible, warnings: [] }, t)
  const top = scored[0]
  const second = scored[1]
  const margin = top && second ? top.score - second.score : Infinity
  const hasDominantWorkflow = Boolean(top && top.score >= MIN_KEYWORD_SCORE && margin >= AMBIGUITY_MARGIN)
  if (isHeadOnlyAnswerAsk(t) && (FORMAT_ONLY_NEGATION.test(t) || !hasDominantWorkflow)) {
    return {
      skill: null,
      layer: 'rule',
      reason: 'answer-format: workflow নয় — unrestricted head-ই requested format-এ উত্তর দেবে',
      candidates: [],
      needsModel: false,
    }
  }

  // Layer 3 — keyword scoring over the eligible set.
  if (picked.length === 0) {
    return { skill: null, layer: 'none', reason: 'কোনো skill যথেষ্ট মেলেনি', candidates: scored, needsModel: false }
  }

  if (!top || top.score < MIN_KEYWORD_SCORE) {
    return {
      skill: null,
      layer: 'none',
      reason: `সবচেয়ে কাছের মিল দুর্বল (${top?.name ?? '—'}: ${top?.score ?? 0}) — ভুল skill pin করার চেয়ে কোনোটা না করা ভালো`,
      candidates: scored.slice(0, 3),
      needsModel: false,
    }
  }
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
 * RAISED AGAIN 9,000 → 13,000 on 2026-08-03 for the Tier-3 Mac skills, on the
 * same reasoning and one more fact: this block is still not wired into any live
 * prompt (`buildRegistryBlock` has no production caller yet), so the raise costs
 * nothing today and the guard keeps doing the only job it currently has —
 * failing loudly instead of shortening every description at once.
 *
 * The cliff itself stays: crossing 13,000 is the next decision, not a silent
 * quality drop.
 */
export const REGISTRY_BUDGET_CHARS = 13000
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
