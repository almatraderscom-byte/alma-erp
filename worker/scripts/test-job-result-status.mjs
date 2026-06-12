#!/usr/bin/env node
/** Verifies job-result status normalization logic (mirrors route). */
function normalizeJobStatus(raw) {
  if (raw === 'success') return 'success'
  if (raw === 'failed') return 'failed'
  if (raw === 'executed') return 'success'
  return null
}

const cases = [
  ['success', 'success'],
  ['failed', 'failed'],
  ['executed', 'success'],
  ['bogus', null],
]

for (const [input, expected] of cases) {
  const got = normalizeJobStatus(input)
  if (got !== expected) throw new Error(`normalize(${input}) = ${got}, expected ${expected}`)
}

console.log('✅ job-result status normalization: success/failed/executed OK')
