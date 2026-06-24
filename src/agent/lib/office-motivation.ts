/**
 * Daily staff motivation — a rotating Bangla one-liner shown beside the
 * "Performer of the Week" hero. Picked deterministically from the Dhaka
 * calendar date so every staff member sees the same line on a given day and it
 * changes once per day (no DB, no API — pure function).
 */
export type Motivation = { text: string; tag: string }

const QUOTES: Motivation[] = [
  { text: 'আজকের ছোট পরিশ্রমই আগামীকালের বড় সাফল্য। বিসমিল্লাহ বলে শুরু করুন!', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'যে কাজ মন দিয়ে করা হয়, তাতেই বরকত। নিজের সেরাটা দিন।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'সফলতা একদিনে আসে না — প্রতিদিনের সততা আর পরিশ্রমেই আসে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'প্রতিটি কাজকে ইবাদত মনে করুন — মান নিজেই বেড়ে যাবে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'আজ একটু বেশি চেষ্টা করুন — কালকের আপনি আজকের আপনাকে ধন্যবাদ দেবে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'গ্রাহকের হাসিই আমাদের আসল পুরস্কার। যত্ন নিয়ে কাজ করুন।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'ধৈর্য আর পরিশ্রম — এই দুটোই বড় হওয়ার চাবিকাঠি। ইনশাআল্লাহ।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'ভালো কাজের কোনো শর্টকাট নেই — কিন্তু প্রতিটি ভালো কাজের পুরস্কার আছে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'দল হিসেবে আমরা শক্তিশালী। একে অপরকে সাহায্য করে এগিয়ে যান।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'আজকের লক্ষ্য: গতকালের চেয়ে একটু ভালো করা। ছোট উন্নতিই বড় পরিবর্তন আনে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'সময়মতো কাজ শেষ করা একটি আমানত। আল্লাহ আমানতদারদের ভালোবাসেন।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'মন খারাপ হলেও থেমে যাবেন না — প্রতিটি সকাল নতুন সুযোগ নিয়ে আসে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'যত্ন করে তোলা একটি ছবি, যত্ন করে লেখা একটি কথা — পুরো ব্র্যান্ডকে সুন্দর করে।', tag: 'আজকের অনুপ্রেরণা' },
  { text: 'নিজের কাজে গর্ব করুন — কারণ আপনি ALMA-কে এগিয়ে নিচ্ছেন।', tag: 'আজকের অনুপ্রেরণা' },
]

/** Returns the motivation line for the given moment's Dhaka calendar date. */
export function dailyMotivation(at: Date = new Date()): Motivation {
  const ymd = at.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' })
  const dayNum = Math.floor(new Date(`${ymd}T00:00:00Z`).getTime() / 86_400_000)
  return QUOTES[((dayNum % QUOTES.length) + QUOTES.length) % QUOTES.length]
}
