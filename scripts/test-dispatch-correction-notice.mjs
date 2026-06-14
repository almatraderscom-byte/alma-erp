/**
 * Unit check: correction notice must not say "coming soon" when dispatch is recent.
 */
import assert from 'node:assert/strict'

function build(staffName, situation) {
  const name = staffName.trim() || 'ভাই'
  if (situation === 'new_already_sent') {
    return (
      `⚠️ গুরুত্বপূর্ণ নোটিশ:\n\n` +
      `আস্সালামু আলাইকুম ${name} ভাই!\n\n` +
      `আগে যে টাস্ক লিস্ট পাঠানো হয়েছিল সেটি বাতিল করা হয়েছে — ওই তালিকা অনুসরণ করবেন না।\n\n` +
      `আপনার কাছে ঠিক মাত্র পাঠানো "📋 আজকের কাজ" লিস্টটিই সঠিক — শুধুমাত্র সেই নতুন তালিকা অনুযায়ী কাজ করুন।\n\n` +
      `জাযাকাল্লাহু খয়রান। 🙏`
    )
  }
  return (
    `⚠️ গুরুত্বপূর্ণ নোটিশ:\n\n` +
    `আস্সালামু আলাইকুম ${name} ভাই!\n\n` +
    `আগের টাস্ক লিস্ট বাতিল হয়েছে। নতুন সঠিক টাস্ক লিস্ট শীঘ্রই পাঠানো হবে — ততক্ষণ অপেক্ষা করুন।\n\n` +
    `জাযাকাল্লাহু খয়রান। 🙏`
  )
}

const already = build('Mustahid', 'new_already_sent')
const waiting = build('Mustahid', 'awaiting_new_dispatch')

assert.match(already, /ঠিক মাত্র পাঠানো/)
assert.doesNotMatch(already, /শীঘ্রই/)
assert.doesNotMatch(already, /একটু পরে/)
assert.match(waiting, /শীঘ্রই/)
assert.match(already, /আস্সালামু আলাইকুম/)

console.log('PASS: dispatch correction notice messages')
