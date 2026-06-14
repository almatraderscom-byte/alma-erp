/**
 * Daily staff morale messages, grouped by theme. The runner picks a theme by
 * rotation and a message within it, personalizing with the staff name.
 * Keep these SINCERE and VARIED. Add more over time.
 */
export const MORALE_THEMES = {
  dignity_of_work: [
    'ভাই, মনে রাখবেন — হালাল পরিশ্রমের চেয়ে সম্মানের কিছু নেই। আপনি আজ যে কাজটা করছেন, সেটা ছোট মনে হলেও আল্লাহর কাছে আপনার সৎ চেষ্টার মূল্য অনেক বড়। 🤲',
    'প্রতিটি কাজ মন দিয়ে করা — এটাই ইহসান। নবীজি (সা.) বলেছেন আল্লাহ ভালোবাসেন যখন কেউ কোনো কাজ করে তা সুন্দরভাবে করে। আপনার আজকের ছবি/কন্টেন্টেও সেই যত্নটা থাকুক। 💪',
  ],
  growth_vision: [
    'ভাই, যারা কোনো কোম্পানির শুরুর দিকে লেগে থাকে, কোম্পানি বড় হলে তারাই সবচেয়ে ভালো জায়গায় পৌঁছায়। আজকের এই পরিশ্রম ভবিষ্যতের ভিত্তি — ইনশাআল্লাহ। 🌱',
    'এই কাজগুলো শেখা মানে শুধু আজকের কাজ না — আপনি একটা skill গড়ছেন যা সারাজীবন কাজে দেবে। CapCut, পেজ ম্যানেজমেন্ট, কন্টেন্ট — এগুলো বড় সুযোগের দরজা খুলবে। 🚪',
  ],
  boss_vision: [
    'একটা কথা ভাবুন — Boss নিজে হাতে এই পুরো সিস্টেমটা দাঁড় করাচ্ছেন, নিজে শিখে, নিজে বানিয়ে। এমন একজন creative মানুষের সাথে শুরুর দিকে থাকতে পারা ভাগ্যের ব্যাপার। আল্লাহ চাইলে এই কোম্পানি একদিন অনেক বড় হবে, ইনশাআল্লাহ — আর আপনারা হবেন তার ভিত্তি। 🏗️',
  ],
  reassure_system: [
    'ভাই, এই track আর reminder গুলো কড়াকড়ির জন্য না — এগুলো আপনাদের কাজ সহজ করতে আর আপনাদের ভালো কাজ Boss এর চোখে তুলে ধরতে। আপনি ভালো করলে সেটা যেন হারিয়ে না যায়, সেটাই উদ্দেশ্য। নিশ্চিন্তে কাজ করুন। 🙂',
    'কেউ ভাববেন না এজেন্ট আপনাদের উপর নজরদারি করছে — আমি বরং আপনাদের পাশে, আপনাদের ভালো কাজটা যেন স্বীকৃতি পায় সেজন্য। যেকোনো সমস্যায় "💬 Feedback" বাটনে বলবেন। 🤝',
  ],
  light_humor: [
    'ভাই, কাজ তো করছেন দারুণ — তবে চা/কফির বিরতিটাও দরকার, নইলে ক্রিয়েটিভিটি rocket এর মতো উড়বে না! ☕😄 একটু রিফ্রেশ হয়ে আবার শুরু করুন।',
    'আজকের mission: হাসিমুখে কাজ, সুন্দর কন্টেন্ট, আর deadline কে বলুন "দেখা হবে"! 😎 চলুন আজকের দিনটা জিতে নিই।',
  ],
  gratitude: [
    'ভাই, আপনাদের পরিশ্রমের জন্য শুকরিয়া। আল্লাহ আপনাদের রিজিকে বরকত দিন এবং পরিশ্রম সফল করুন। আজকের দিনটা ভালো কাটুক। 🤲',
  ],
}

const THEME_ORDER = ['dignity_of_work', 'growth_vision', 'reassure_system', 'light_humor', 'boss_vision', 'gratitude']

/** Pick a message for a given day index, rotating themes so it never repeats back-to-back. */
export function pickMoraleMessage(dayIndex, staffName) {
  const theme = THEME_ORDER[dayIndex % THEME_ORDER.length]
  const list = MORALE_THEMES[theme] ?? MORALE_THEMES.dignity_of_work
  const msg = list[Math.floor(dayIndex / THEME_ORDER.length) % list.length]
  return `${staffName ? `${staffName} ভাই — ` : ''}${msg}`
}

/** Tue & Fri — adaptive LLM message (~2 days/week). */
export function shouldUseAdaptiveMorale(dayIndex) {
  const dow = dayIndex % 7
  return dow === 2 || dow === 5
}
