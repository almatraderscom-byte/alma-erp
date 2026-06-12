/**
 * /help — grouped Bangla guide with examples.
 */

export function buildOwnerHelpText() {
  return (
    `*ALMA Assistant — সাহায্য*\n\n` +
    `যেকোনো বার্তা পাঠালে এজেন্ট উত্তর দেবে। ভয়েস নোটও পাঠাতে পারেন।\n` +
    `/menu — বাটন দিয়ে সব কন্ট্রোল\n\n` +
    `*📊 ব্যবসা*\n` +
    `/today — আজকের স্ন্যাপশট (টাস্ক, নামাজ, সেলস)\n` +
    `/khoroch — আজ + এই মাসের খরচ\n` +
    `/pawna — পাওনা-দেনার তালিকা\n` +
    `/details — নাম বেছে নিন (বাটন)\n` +
    `/ask — উদাহরণ প্রশ্ন বাটন\n\n` +
    `*🤖 কাস্টমার এজেন্ট*\n` +
    `/cs — কন্ট্রোল প্যানেল (বাটন)\n` +
    `/csstatus /csshadow /csauto /csoff — এক ট্যাপে মোড\n` +
    `/cs followups on — ফলো-আপ চালু\n` +
    `/cs block 123456 — কাস্টমার ব্লক\n` +
    `/postlink <পোস্ট> FM-204 — FB পোস্ট লিঙ্ক\n\n` +
    `*🕌 সালাত*\n` +
    `নামাজের বাটন দিয়ে মার্ক করুন — /menu → সালাত\n\n` +
    `*⏰ রিমাইন্ডার*\n` +
    `/menu → রিমাইন্ডার তালিকা\n\n` +
    `*📦 ক্যাটালগ*\n` +
    `/catalog — ছবির অগ্রগতি\n` +
    `/catalog suggest — রোটেশন সাজেস্ট (Owner)\n` +
    `/group — ডিজাইন গ্রুপ\n` +
    `/sizechart — সাইজ চার্ট\n` +
    `ফটো + ক্যাপশনে কোড — ছবি যোগ\n\n` +
    `*💬 চ্যাট*\n` +
    `/new — নতুন কথোপকথন\n` +
    `/chats — পুরানো চ্যাট\n\n` +
    `*👥 স্টাফ*\n` +
    `/staff link Eyafi 123456789 — স্টাফ লিঙ্ক\n` +
    `/staff_onboard — GPS গাইড মেসেজ\n\n` +
    `*⚙️ সিস্টেম*\n` +
    `/menu → Scheduler / Worker health`
  )
}

export function buildStaffHelpText() {
  return (
    `*ALMA স্টাফ বট*\n\n` +
    `• ফটো পাঠান — ক্যাপশনে প্রোডাক্ট কোড (যেমন FM-204)\n` +
    `/catalog — ছবির অগ্রগতি\n` +
    `/group — ফ্যামিলি ডিজাইন গ্রুপ\n` +
    `• কাজের টাস্ক এলে ✅ Done চাপুন\n` +
    `• লোকেশন শেয়ার (ঐচ্ছিক)\n\n` +
    `এই বট সাধারণ চ্যাটের উত্তর দেয় না — শুধু ক্যাটালগ ও টাস্ক।`
  )
}
