/**
 * Telegram Bot API command menu — owner vs staff scopes.
 */

/** @type {Array<{ command: string, description: string }>} */
export const OWNER_COMMANDS = [
  { command: 'menu', description: 'সব কন্ট্রোল বাটনে দেখুন' },
  { command: 'today', description: 'আজকের ব্যবসার সারসংক্ষেপ' },
  { command: 'khoroch', description: 'আজ ও এই মাসের খরচ' },
  { command: 'pawna', description: 'কে কত পাবে/দেবে' },
  { command: 'details', description: 'কারো পুরো হিসাব (নাম লিখুন)' },
  { command: 'ask', description: 'এজেন্টকে প্রশ্ন করুন' },
  { command: 'cs', description: 'কাস্টমার এজেন্ট চালু/বন্ধ/মোড' },
  { command: 'postlink', description: 'FB পোস্টে প্রোডাক্ট লিঙ্ক' },
  { command: 'catalog', description: 'ছবি যোগের অগ্রগতি' },
  { command: 'group', description: 'ফ্যামিলি ডিজাইন গ্রুপ' },
  { command: 'sizechart', description: 'বয়স→সাইজ চার্ট' },
  { command: 'new', description: 'নতুন কথোপকথন' },
  { command: 'chats', description: 'পুরানো চ্যাট বেছে নিন' },
  { command: 'staff', description: 'স্টাফ টেলিগ্রাম লিঙ্ক' },
  { command: 'staff_onboard', description: 'স্টাফ GPS অনবোর্ডিং গাইড' },
  { command: 'help', description: 'সাহায্য ও উদাহরণ' },
  { command: 'start', description: 'বট শুরু করুন' },
]

/** Linked staff — no finance, CS, or owner agent commands */
export const STAFF_COMMANDS = [
  { command: 'catalog', description: 'ছবি যোগের অগ্রগতি' },
  { command: 'group', description: 'ফ্যামিলি ডিজাইন গ্রুপ' },
  { command: 'help', description: 'স্টাফ সাহায্য' },
  { command: 'start', description: 'বট শুরু করুন' },
]

export async function registerBotCommands(bot, ownerChatId) {
  try {
    await bot.telegram.setMyCommands(STAFF_COMMANDS, { scope: { type: 'default' } })
    if (ownerChatId) {
      const chatId = Number(ownerChatId)
      if (Number.isFinite(chatId)) {
        await bot.telegram.setMyCommands(OWNER_COMMANDS, {
          scope: { type: 'chat', chat_id: chatId },
        })
      }
    }
    console.log(`[telegram] setMyCommands: owner=${OWNER_COMMANDS.length} default(staff)=${STAFF_COMMANDS.length}`)
  } catch (err) {
    console.error('[telegram] setMyCommands failed:', err.message)
  }
}
