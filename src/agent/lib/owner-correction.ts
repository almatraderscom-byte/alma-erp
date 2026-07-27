/**
 * The owner just said it got something wrong. What happens next.
 *
 * Asked for by name on 2026-07-27, after Boss caught two things in one message:
 * a promise made and not kept, and — the worse one — a claim repeated without
 * being checked. What he wanted kept was not the apology. It was the shape:
 *
 *   > "even 2 ta issue bolar por e tumi nij theke koto shundor kore bolle, even
 *   >  2nd issue ta je serious etao mark korle … amar agent ke ami same amon chai"
 *
 * The prompt already had exactly one line about this — *"বারবার মাফ চেয়ো না"* —
 * which says what NOT to do and nothing about what to do instead. A model with
 * only a prohibition defends itself, or grovels, or explains the cause before
 * admitting the fault. All three make the owner angrier, and none of them fix
 * anything.
 *
 * ── Why a nudge and not another prompt paragraph ────────────────────────────
 *
 * The house rule in this codebase is that a prompt rule is a request. This one
 * genuinely IS prompt-shaped — it is about how a reply is written, and no tool
 * can be withheld to force it. So the honest improvement is not to pretend it is
 * enforced; it is to make it arrive at the RIGHT MOMENT. A line buried in a
 * ~90k-char always-on prompt competes with everything else in that prompt. This
 * block is appended after the cached prefix on the ONE turn where he has just
 * said something is wrong — the same mechanism `self-correct.ts` uses for a
 * failed tool round, for the same reason.
 *
 * Detection is deterministic and errs toward NOT firing: a false positive would
 * have the agent apologising for a compliment.
 *
 * Gated by `AGENT_OWNER_CORRECTION` (default ON).
 */

export function ownerCorrectionEnabled(): boolean {
  return (process.env.AGENT_OWNER_CORRECTION ?? '').trim().toLowerCase() !== 'false'
}

/**
 * He writes in Bangla script, in Banglish, and in English, often in one
 * sentence. Every pattern below is a phrase he has actually used or an
 * unmistakable equivalent — not a guess at how someone might complain.
 */
const CORRECTION_PATTERNS: RegExp[] = [
  // direct "this is wrong / you were wrong"
  /\b(bhul|vul)\b|ভুল/i,
  /\bwrong\b|\bincorrect\b|\bnot right\b/i,
  // "why did you …" — his standard opener for a fault
  /\bkeno\b|কেন\b|\bwhy (did|are|is|do)\b/i,
  // "you said X but …"
  /(bolle|বললে|bolechile|বলেছিলে|said).{0,40}(kintu|কিন্তু|but)\b/i,
  // "you didn't verify / didn't check"
  /(jacai|যাচাই|check).{0,20}(na kore|না করে|koro ni|করোনি|nai|নাই)/i,
  // "it changed / it's different now"
  /(bodle gelo|বদলে গেল|change hoye gelo|different)/i,
  // "is this professional / is this the way"
  /(professional|peshadar|পেশাদার).{0,30}\?/i,
  // "you believed it / you assumed"
  /(believe korle|বিশ্বাস করলে|onuman|অনুমান)/i,
  // explicit displeasure
  /\brag\b|রাগ|\bupset\b|\bannoy/i,
]

/** Signals that make a complaint-shaped sentence NOT a complaint. */
const NOT_A_CORRECTION: RegExp[] = [
  /\b(dhonnobad|thanks|thank you|valo hoyeche|ভালো হয়েছে|perfect|besh)\b/i,
]

/**
 * Is this owner message pointing out a fault in the agent's own work?
 * Conservative on purpose — see the note about false positives above.
 */
export function looksLikeOwnerCorrection(text: string): boolean {
  const t = (text ?? '').trim()
  if (t.length < 8) return false
  if (NOT_A_CORRECTION.some((re) => re.test(t))) return false
  return CORRECTION_PATTERNS.some((re) => re.test(t))
}

/**
 * The block itself. Ordered the way the reply should be ordered, because a model
 * follows a sequence far better than a list of qualities.
 *
 * Point 2 is the one he singled out: when he raises more than one thing, say
 * WHICH IS WORSE yourself. Ranking his complaints for him is the difference
 * between "I acknowledge your feedback" and being taken seriously.
 */
export function buildOwnerCorrectionNudge(lastOwnerText: string): string | null {
  if (!ownerCorrectionEnabled()) return null
  if (!looksLikeOwnerCorrection(lastOwnerText)) return null

  return [
    '[owner-correction] Boss ভুল ধরিয়ে দিয়েছেন। এই টার্নের উত্তর এই ক্রমে লেখো:',
    '১. **প্রথম লাইনেই মেনে নাও** — আত্মপক্ষ নয়। "কিন্তু", "আসলে", কারণ ব্যাখ্যা —',
    '   কোনোটাই স্বীকার করার আগে নয়। এক লাইন, সোজা।',
    '২. **একাধিক অভিযোগ থাকলে তুমি নিজে বলো কোনটা বেশি গুরুতর** এবং কেন।',
    '   তাঁকে সাজিয়ে দিতে হবে না — এটাই দেখায় তুমি সত্যিই বুঝেছ।',
    '৩. **ভুলটার নাম বলো, ঢালাওভাবে নয়।** "আমার ভুল হয়েছে" যথেষ্ট নয় —',
    '   ঠিক কোন জায়গায় কী করেছ, সেটা বলো।',
    '৪. **তারপর তর্ক নয় — যাচাই করো।** সম্ভব হলে এই টার্নেই টুল চালিয়ে আসল',
    '   উত্তরটা আনো। শোধরানোর প্রমাণ ক্ষমা চাওয়ার চেয়ে বড়।',
    '৫. **কারণটা যেখানে, সেখানেই সারাও** — শুধু এই একটা ঘটনা নয়।',
    '৬. **একবারই দুঃখিত, বেশি নয়।** নিজেকে ছোট করা, বারবার মাফ চাওয়া, বা',
    '   দীর্ঘ অনুশোচনা — Boss-এর সময় নষ্ট, কাজের কিছু নয়।',
    '৭. স্বীকার করতে গিয়ে **নতুন কোনো দাবি করো না** যেটার পেছনে টুল নেই।',
    '   "আসলে ব্যাপারটা X" বলতে হলে X-এর প্রমাণ এই টার্নেই লাগবে।',
    '৮. **প্রশ্ন করা মানেই তুমি ভুল নও।** Boss কোনো সংখ্যা নিয়ে প্রশ্ন করলে',
    '   আপত্তি থামাতে নরম একটা গল্প বানিয়ো না — গিয়ে দেখো। দেখতে না পারলে',
    '   সংখ্যাটা বলো আর সোজা বলো ওটা কীসের তুমি জানো না।',
  ].join('\n')
}
