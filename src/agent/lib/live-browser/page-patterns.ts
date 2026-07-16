/**
 * Page intelligence for the live browser (owner escalation 2026-07-16:
 * "agent page e gele onk kichu chine na / simple kaj bujhe na").
 *
 * Every look now carries a PATTERN VERDICT: cheap, deterministic heuristics
 * over the page text + clickable elements that recognise the UI situations a
 * human handles reflexively — a cookie wall, a login gate, a blocking modal,
 * a captcha, an error page, a search-results list, a checkout form — plus the
 * Bangla playbook hint for each ("আগে banner-এর Accept/বন্ধ বোতামটা চাপো…").
 * The model stops staring at a consent overlay thinking the site is broken.
 *
 * Deliberately NOT a model call: this runs on every look, so it must be free,
 * instant and deterministic. Patterns are additive — multiple can fire.
 */

export interface PagePatternVerdict {
  patterns: string[]
  /** One Bangla action hint per detected pattern, most blocking first. */
  hintsBn: string[]
}

interface PatternRule {
  id: string
  /** Blocking patterns sort first — they must be handled before the task. */
  blocking: boolean
  test: (text: string, elementsBlob: string, url: string) => boolean
  hintBn: string
}

const RULES: PatternRule[] = [
  {
    id: 'captcha_or_botwall',
    blocking: true,
    test: (t) =>
      /verify you are human|are you a robot|unusual traffic|checking your browser|cloudflare|press and hold|recaptcha|hcaptcha/i.test(t),
    hintBn:
      'CAPTCHA/bot-wall — এটা তুমি পার হবে না এবং চেষ্টা করাও নিষেধ। Boss-কে বলো এই সাইটে ম্যানুয়াল verification লাগবে; উনি পার করে দিলে তারপর এগোবে।',
  },
  {
    id: 'cookie_banner',
    blocking: true,
    test: (t, e) =>
      /(accept (all )?cookies|allow (all )?cookies|we use cookies|cookie settings|consent|কুকি)/i.test(t) &&
      /accept|allow|agree|got it|ok/i.test(e),
    hintBn:
      'Cookie/consent banner পেজ ঢেকে রেখেছে — আগে "Accept"/"Allow all"/"Agree" বোতামটা click করো, তারপর আসল কাজ। banner-এর লেখা পেজের content ভেবো না।',
  },
  {
    id: 'login_wall',
    blocking: true,
    test: (t, e) =>
      /(log ?in|sign ?in|লগ ?ইন|create an account to continue|you must be logged in|session expired|পুনরায় লগইন)/i.test(t) &&
      /password|পাসওয়ার্ড|log ?in|sign ?in/i.test(e),
    hintBn:
      'Login-দেয়াল — credentials টাইপ করা তোমার জন্য নিষেধ। Boss-কে বলো এই সাইটে লগইন লাগবে; উনি লগইন করে দিলে তারপর কাজ চালাবে। ভুলেও পাসওয়ার্ড চেয়ো না।',
  },
  {
    id: 'blocking_modal',
    blocking: true,
    test: (t, e) =>
      /(subscribe to continue|newsletter|sign up for|app-?e দেখুন|open in app|download (the|our) app|notification(s)? চালু|allow notifications)/i.test(t) &&
      /close|dismiss|×|✕|not now|later|no thanks|বন্ধ/i.test(e),
    hintBn:
      'Popup/modal পেজ ঢেকে রেখেছে (newsletter/app-nag/notification) — আগে "✕"/"Not now"/"No thanks" দিয়ে বন্ধ করো, তারপর পেজ পড়ো।',
  },
  {
    id: 'error_page',
    blocking: true,
    test: (t) =>
      /(404|page not found|পেজ(টি)? খুঁজে পাওয়া যায়নি|500 internal|service unavailable|this site can.t be reached|dns_probe|err_connection)/i.test(t),
    hintBn:
      'Error পেজ (404/500/unreachable) — এই URL-এ content নেই। URL অনুমান করে ঢুকো না; সাইটের HOME-এ ফিরে menu/search দিয়ে খোঁজো।',
  },
  {
    id: 'search_results',
    blocking: false,
    test: (t, _e, url) =>
      /[?&](q|query|s|search)=/i.test(url) || /(search results|ফলাফল|showing \d+ (of|results)|results for)/i.test(t),
    hintBn:
      'এটা search-results তালিকা — প্রতিটা ফল আলাদা লিঙ্ক। সবচেয়ে মিল-থাকা ফলটার লিঙ্ক-টেক্সটে click করো; প্রথমটাই সঠিক ধরে নিয়ো না।',
  },
  {
    id: 'form_page',
    blocking: false,
    test: (_t, e) => (e.match(/"(input|textarea|select)"/g) ?? []).length >= 4,
    hintBn:
      'এটা ফর্ম-পেজ — ক্ষেতগুলো উপর থেকে নিচে এক এক করে পূরণ করো (type per field), প্রতিটার পর look দিয়ে মান বসেছে কি না দেখো। শেষ Submit/Send Boss-এর কাজ হলে সেটা ওঁর জন্য রেখে দাও।',
  },
  {
    id: 'infinite_feed',
    blocking: false,
    test: (_t, _e, url) =>
      /facebook\.com|instagram\.com|twitter\.com|x\.com|linkedin\.com|youtube\.com/i.test(url),
    hintBn:
      'এটা lazy-loading feed — এক স্ক্রিনে সামান্যই থাকে। পুরো ছবি পেতে sweep:true দিয়ে look করো, বা নির্দিষ্ট পোস্ট খুঁজলে scroll করে করে দেখো।',
  },
  {
    id: 'checkout_or_payment',
    blocking: false,
    test: (t) =>
      /(checkout|payment method|card number|billing address|পেমেন্ট|মোট মূল্য|place order|pay now)/i.test(t),
    hintBn:
      'Checkout/payment এলাকা — টাকা-সংক্রান্ত চূড়ান্ত click (Pay/Place order) সম্পূর্ণ নিষেধ, ওটা Boss নিজে চাপবেন। তুমি শুধু তথ্য পূরণ/verify পর্যন্ত।',
  },
]

export function classifyPagePatterns(input: {
  text: string
  /** JSON.stringify of the elements list (or any joined labels blob). */
  elementsBlob: string
  url: string
}): PagePatternVerdict {
  const text = (input.text ?? '').slice(0, 20_000)
  const blob = (input.elementsBlob ?? '').slice(0, 40_000)
  const url = input.url ?? ''
  const hits = RULES.filter((r) => {
    try {
      return r.test(text, blob, url)
    } catch {
      return false
    }
  })
  hits.sort((a, b) => Number(b.blocking) - Number(a.blocking))
  return {
    patterns: hits.map((h) => h.id),
    hintsBn: hits.map((h) => h.hintBn),
  }
}
