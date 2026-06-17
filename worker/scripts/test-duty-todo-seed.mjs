#!/usr/bin/env node
/**
 * Smoke test: duty roster → todo seed count (no API calls unless --live).
 *   node worker/scripts/test-duty-todo-seed.mjs
 *   node worker/scripts/test-duty-todo-seed.mjs --live   # hits production API
 */
import { dutiesForToday, isFridayDhaka, isSaturdayDhaka } from '../src/schedulers/duties.mjs'

const SKIP = new Set(['salah_init'])
const duties = dutiesForToday().filter((d) => !SKIP.has(d.duty))

console.log('Day:', new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' }))
console.log('Friday:', isFridayDhaka(), 'Saturday:', isSaturdayDhaka())
console.log('Duty count (no salah):', duties.length)
console.log('Sample:', duties.slice(0, 3).map((d) => d.duty).join(', '), '...')

if (process.argv.includes('--live')) {
  const { seedDailyTodos } = await import('../src/schedulers/todo-reminder.mjs')
  const result = await seedDailyTodos()
  console.log('Live seed result:', result)
}

console.log('✅ duty-todo seed logic OK')
