#!/usr/bin/env node
/**
 * Smoke test for claim-verifier regex rules.
 * Run: npx tsx scripts/test-claim-verifier.mjs
 */
import { detectClaimViolations } from '../src/agent/lib/claim-verifier.ts'

const cases = [
  // Violations expected (no tool call this turn)
  { text: '✅ যোহর mark হয়েছে — এখন আর call আসবে না', tools: [], expect: ['salah_mark'] },
  { text: 'যোহর mark করে দিলাম স্যার', tools: [], expect: ['salah_mark'] },
  { text: 'এখন আর call আসবে না', tools: [], expect: ['salah_mark'] },
  { text: '২০ মিনিট সময় দিলাম স্যার, কল বন্ধ', tools: [], expect: ['salah_delay'] },
  { text: 'lock করে দিলাম 15 মিনিট', tools: [], expect: ['salah_delay'] },
  { text: 'মনে রাখলাম স্যার', tools: [], expect: ['memory_save'] },
  { text: 'reminder সেট করে দিলাম স্যার', tools: [], expect: ['reminder_set'] },
  { text: 'টাস্ক পাঠিয়ে দিয়েছি স্টাফ কে', tools: [], expect: ['staff_dispatch'] },
  { text: 'facebook এ পোস্ট করে দিলাম', tools: [], expect: ['fb_post'] },

  // No violation when tool was called
  { text: '✅ যোহর mark হয়েছে', tools: ['mark_salah'], expect: [] },
  { text: '২০ মিনিট সময় দিলাম', tools: ['request_salah_delay'], expect: [] },
  { text: 'মনে রাখলাম', tools: ['save_memory'], expect: [] },
  { text: 'reminder সেট হয়েছে', tools: ['set_reminder'], expect: [] },

  // No violation: question / future intent / unrelated
  { text: 'যোহর পড়েছেন কি স্যার?', tools: [], expect: [] },
  { text: 'মনে রাখব স্যার', tools: [], expect: [] },
  { text: '১৫ মিনিট পর কল করব', tools: [], expect: [] },
  { text: 'আজকে কেমন আছেন?', tools: [], expect: [] },
]

let pass = 0
let fail = 0

for (const c of cases) {
  const v = detectClaimViolations(c.text, c.tools)
  const cats = [...new Set(v.map((x) => x.category))].sort()
  const expected = [...c.expect].sort()
  const ok = JSON.stringify(cats) === JSON.stringify(expected)
  if (ok) {
    pass++
    console.log(`PASS: "${c.text.slice(0, 50)}" → [${cats.join(',')}]`)
  } else {
    fail++
    console.error(`FAIL: "${c.text}"`)
    console.error(`   expected: [${expected.join(',')}]`)
    console.error(`   got:      [${cats.join(',')}]`)
    if (v.length) {
      console.error(`   matched snippets: ${v.map((x) => `${x.ruleId}:"${x.matchedSnippet}"`).join(' | ')}`)
    }
  }
}

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
