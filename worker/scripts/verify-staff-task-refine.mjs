#!/usr/bin/env node
/**
 * Owner verification for fix/staff-task-refine — pure logic checks (no DB/Telegram).
 */
import { buildProgressiveSummary } from '../src/staff/task-progress.mjs'
import { buildBonusTasks } from '../src/staff/bonus-task-suggest.mjs'
import { buildTasksForStaff, DEFAULT_PROFILES } from '../src/staff/evening-proposal.mjs'
import { formatDhakaDateLabel, bnNum } from '../src/staff/bn-format.mjs'

let passed = 0
let failed = 0

function assert(cond, label) {
  if (cond) {
    passed++
    console.log(`  ✅ ${label}`)
  } else {
    failed++
    console.error(`  ❌ ${label}`)
  }
}

console.log('\n=== Issue 2: Progressive summary ===')
const tasks = [
  { id: '1', title: 'FM-133 — FB/অ্যাড ক্রিয়েটিভ', status: 'done' },
  { id: '2', title: 'FM-133T — ক্যাপশন ও হ্যাশট্যাগ', status: 'done' },
  { id: '3', title: 'Alma Lifestyle FB — কভার', status: 'done' },
  { id: '4', title: '৬টি পেন্ডিং অর্ডার ফলো-আপ', status: 'sent' },
  { id: '5', title: 'Classic White Punjabi — কন্টেন্ট', status: 'sent' },
  { id: '6', title: 'Royal Blue Punjabi — কন্টেন্ট', status: 'sent' },
  { id: '7', title: 'Embroidered Punjabi — কন্টেন্ট', status: 'sent' },
  { id: '8', title: '110T — লিস্টিং আপডেট', status: 'sent' },
]
const msg = buildProgressiveSummary('Mohammad Eyafi', tasks)
assert(msg.includes(`${bnNum(8)} এর মধ্যে ${bnNum(3)} সম্পন্ন`), 'shows ৮ এর মধ্যে ৩ সম্পন্ন')
assert(msg.includes('☑️ 1.'), 'done list numbered')
assert(msg.includes('⏳ 4.'), 'pending continues numbering')
assert(msg.includes('বাকি ৫টি'), 'pending count')

console.log('\n=== Issue 3: Evening proposal labels ===')
assert(formatDhakaDateLabel('2026-06-14').includes('জুন'), 'Bengali date label')
const staff = { id: 's1', name: 'Mohammad Eyafi', role: 'content' }
const profile = DEFAULT_PROFILES['Mohammad Eyafi']
const carry = [{ staff_id: 's1', title: '↩ FM-100 — listing', type: 'listing_update', source: 'carry_forward' }]
const built = buildTasksForStaff(staff, profile, [], carry, 0)
assert(built[0]?.title?.startsWith('🔄 গতকাল থেকে বাকি:'), 'carry-forward shown first with 🔄 label')

console.log('\n=== Issue 4: Bonus tasks (3–4, skip done types) ===')
const existing = [
  { type: 'video_reel', title: 'done reel' },
  { type: 'ad_creative', title: 'done ad' },
  { type: 'product_content', title: 'done content' },
  { type: 'page_management', title: 'done page' },
]
const bonus = buildBonusTasks(
  staff,
  profile,
  [{ name: 'FM-200', productRef: 'FM-200', reasons: ['test'] }, { name: 'FM-110', productRef: 'FM-110', reasons: ['boost'] }],
  3,
  existing,
)
assert(bonus.length >= 1 && bonus.length <= 4, `bonus count 1–4 (got ${bonus.length})`)
assert(!bonus.some((t) => existing.some((e) => e.type === t.type)), 'no duplicate task types')

console.log('\n=== Issue 1: No promptTaskDoneLocation export ===')
try {
  await import('../src/telegram/location.mjs')
  const loc = await import('../src/telegram/location.mjs')
  assert(loc.promptTaskDoneLocation === undefined, 'promptTaskDoneLocation removed')
} catch (err) {
  failed++
  console.error('  ❌ location.mjs import failed:', err.message)
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
